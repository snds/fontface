//! Tags, and colors for tags and library locations.
//!
//! **Tags attach to a font's identity, not to a database row.** The key is the one library.ts
//! groups duplicate copies by: PostScript name, variable or static, upright or italic. So every
//! copy of a font shares its tags, and a rescan or a re-download keeps them. A font without a
//! PostScript name is keyed by its file path and face index instead.
//!
//! Imports can also store a *loose* key, `ps:<name>`, which matches every font with that
//! PostScript name. It's kept for fonts that aren't in the library yet, so they get their tags
//! when they arrive.
//!
//! **Nested tags.** A `/` in a name nests it: "Sci-Fi/Star Trek" sits under "Sci-Fi". Parents
//! always exist as tags of their own, so every level can be colored, renamed and viewed.
//!
//! **Groups.** Every tag is in one of two groups: the user's own ("My tags") or "Built-in"
//! (tags that came with Font Book and Typeface, such as "Fixed Width" or "Style/Sans"). A group
//! belongs to a top-level tag and everything nested under it, so the `builtin` column of a
//! nested tag always matches its top-level tag's. Every write keeps it that way: a new nested
//! tag takes its parent's group, a tag moved under another takes the new parent's, and
//! [`set_group`] changes a whole subtree at once. [`BUILTIN_NAMES`] decides where tags start.
//!
//! **Schema.** These tables live outside the numbered migrations in db.rs, and PRAGMA
//! user_version is left alone, so other features can add tables without clashing.
//! `ensure_schema` creates whatever is missing and is safe to run at every launch. Add new
//! columns with `ensure_column`, never with a migration.

pub mod colors;
pub mod commands;
pub mod export;
pub mod import;
pub mod named_styles;
pub mod relocate;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod typeface;

#[cfg(test)]
mod tests;

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color       TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tag_fonts (
    tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    face_key  TEXT NOT NULL,
    added_at  INTEGER NOT NULL,
    PRIMARY KEY (tag_id, face_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tag_fonts_key ON tag_fonts(face_key);
CREATE TABLE IF NOT EXISTS location_colors (
    location  TEXT PRIMARY KEY,
    color     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folder_moves (
    old_root  TEXT PRIMARY KEY,
    new_root  TEXT NOT NULL,
    moved_at  INTEGER NOT NULL
);
";

/// Creates the tag tables and columns if they're missing. Idempotent; called once at launch,
/// after db.rs has migrated the library.
///
/// The first time the `builtin` column is added, existing tags are sorted into the two groups
/// by [`BUILTIN_NAMES`], in the same transaction. That happens once only: later launches find
/// the column and leave every tag where the user put it.
pub fn ensure_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)?;
    let tx = conn.unchecked_transaction()?;
    if ensure_column(&tx, "tags", "builtin", "builtin INTEGER NOT NULL DEFAULT 0")? {
        sort_into_groups(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

/// Adds a column if the table doesn't have it yet. `decl` is the column definition, such as
/// `"note TEXT"`. Use this for any later column, so libraries from either branch keep working.
/// Returns true if it added the column (false if it was already there).
pub fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> AppResult<bool> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        params![table, column],
        |r| r.get(0),
    )?;
    if !exists {
        conn.execute_batch(&format!("ALTER TABLE \"{table}\" ADD COLUMN {decl};"))?;
    }
    Ok(!exists)
}

/// The one-time sort when groups arrive: tags under a name in [`BUILTIN_NAMES`] go to
/// Built-in, every other tag stays the user's own. Returns how many tags moved.
fn sort_into_groups(conn: &Connection) -> AppResult<usize> {
    let mut moved = 0;
    for tag in list_tags(conn)? {
        if is_builtin_name(&tag.name) {
            moved += conn.execute("UPDATE tags SET builtin = 1 WHERE id = ?1", [tag.id])?;
        }
    }
    Ok(moved)
}

// ---------------------------------------------------------------------------------- groups

/// Top-level tag names that came with other apps rather than from the user. A tag with one of
/// these names, and every tag nested under it, starts in the Built-in group:
///
/// - when groups first arrive (the one-time sort in [`ensure_schema`]);
/// - when an import creates it (Typeface backups, Font Book collections, Finder tags, and
///   Fontface tags files that don't say which group a tag is in).
///
/// Tags made in Fontface itself always start as the user's own, whatever their name, and a tag
/// that already exists keeps its group. Names match ignoring letter case (ASCII only, like the
/// database).
///
/// - Font Book's starter collections, which macOS makes for every user: "Fixed Width", "Fun",
///   "Modern", "PDF", "Traditional" and "Web".
/// - Typeface's automatic classification, "Style" ("Style/Sans", "Style/Serif",
///   "Style/Monospaced", "Style/Script", "Style/Ornamental", "Style/Symbolic").
pub const BUILTIN_NAMES: &[&str] = &["Fixed Width", "Fun", "Modern", "PDF", "Traditional", "Web", "Style"];

/// The top level of a name: "Sci-Fi" for "Sci-Fi/Star Trek".
pub fn top_level(name: &str) -> &str {
    name.split('/').next().unwrap_or(name)
}

/// True if a tag of this name starts in the Built-in group: its top level is in [`BUILTIN_NAMES`].
pub fn is_builtin_name(name: &str) -> bool {
    let top = top_level(name).trim();
    BUILTIN_NAMES.iter().any(|b| b.eq_ignore_ascii_case(top))
}

/// Puts a tag's top-level tag, and every tag nested under it, in the Built-in group (`builtin`)
/// or the user's own. A nested tag can't be in another group than its top-level tag, so this
/// always acts on the top level. Returns the top-level tag.
pub fn set_group(conn: &mut Connection, id: i64, builtin: bool) -> AppResult<Tag> {
    let tag = get_tag(conn, id)?;
    let top = match find_tag(conn, top_level(&tag.name))? {
        Some(top) => top,
        // Parents always exist; if one somehow doesn't, the tag itself is the top of what's there.
        None => tag,
    };
    let ids: Vec<i64> = subtree(conn, &top)?.into_iter().map(|t| t.id).collect();
    let tx = conn.transaction()?;
    for id in &ids {
        tx.execute("UPDATE tags SET builtin = ?1 WHERE id = ?2", params![builtin, id])?;
    }
    tx.commit()?;
    get_tag(conn, top.id)
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ------------------------------------------------------------------------------- face keys

/// The identity tags attach to. Must match `faceKey` in src/library.ts exactly.
pub fn face_key(postscript_name: Option<&str>, variable: bool, italic: bool, path: &str, face_index: u32) -> String {
    match postscript_name.filter(|p| !p.is_empty()) {
        Some(ps) => format!("ps:{ps}|{}|{}", if variable { "var" } else { "static" }, if italic { "i" } else { "r" }),
        None => format!("file:{path}#{face_index}"),
    }
}

/// A key that matches every face with this PostScript name, whatever its kind or slant.
pub fn loose_key(postscript_name: &str) -> String {
    format!("ps:{postscript_name}")
}

/// The PostScript name in a full or loose key.
pub fn key_postscript_name(key: &str) -> Option<&str> {
    let rest = key.strip_prefix("ps:")?;
    Some(match rest.rsplitn(3, '|').collect::<Vec<_>>().as_slice() {
        [slant, kind, name] if matches!(*slant, "i" | "r") && matches!(*kind, "var" | "static") => name,
        _ => rest,
    })
}

/// True for a loose key (a PostScript name with no kind or slant).
pub fn is_loose(key: &str) -> bool {
    key.strip_prefix("ps:").is_some_and(|_| key_postscript_name(key).map(str::len) == Some(key.len() - 3))
}

pub(crate) fn check_key(key: &str) -> AppResult<()> {
    let ok = key.len() <= 4400
        && match (key.strip_prefix("ps:"), key.strip_prefix("file:")) {
            (Some(rest), _) => !rest.is_empty(),
            (_, Some(rest)) => rest.contains('#'),
            _ => false,
        };
    if ok {
        Ok(())
    } else {
        Err(AppError::Invalid("That isn't a font Fontface knows how to tag".into()))
    }
}

// ----------------------------------------------------------------------------------- names

pub const MAX_NAME: usize = 200;

/// Tidies a tag name: trims each level, squeezes spaces and drops empty levels, so
/// " Sci-Fi / Star  Trek/ " becomes "Sci-Fi/Star Trek".
pub fn normalize_name(raw: &str) -> AppResult<String> {
    let levels: Vec<String> = raw
        .split('/')
        .map(|p| p.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|p| !p.is_empty())
        .collect();
    if levels.is_empty() {
        return Err(AppError::Invalid("A tag needs a name".into()));
    }
    let name = levels.join("/");
    if name.chars().any(char::is_control) {
        return Err(AppError::Invalid("Tag names can't contain control characters".into()));
    }
    if name.chars().count() > MAX_NAME {
        return Err(AppError::Invalid(format!("Tag names can be at most {MAX_NAME} characters")));
    }
    Ok(name)
}

/// Rewrites the parent levels of `name` in the spelling of tags that already exist, so a
/// new "sci-fi/Aliens" joins an existing "Sci-Fi" rather than standing apart from it.
fn with_existing_parents(conn: &Connection, name: &str) -> AppResult<String> {
    let Some((parents, leaf)) = name.rsplit_once('/') else { return Ok(name.to_string()) };
    let mut path = String::new();
    for level in parents.split('/') {
        let wanted = if path.is_empty() { level.to_string() } else { format!("{path}/{level}") };
        path = find_tag(conn, &wanted)?.map(|t| t.name).unwrap_or(wanted);
    }
    Ok(format!("{path}/{leaf}"))
}

/// "a/b/c" → ["a", "a/b"].
pub fn parent_names(name: &str) -> Vec<String> {
    name.match_indices('/').map(|(i, _)| name[..i].to_string()).collect()
}

/// True if `name` is `ancestor` itself or nested anywhere under it. Letter case is ignored the
/// way SQLite's NOCASE does it (ASCII letters only), so this agrees with the unique index.
pub fn is_within(name: &str, ancestor: &str) -> bool {
    name.len() >= ancestor.len()
        && name.is_char_boundary(ancestor.len())
        && name[..ancestor.len()].eq_ignore_ascii_case(ancestor)
        && (name.len() == ancestor.len() || name.as_bytes()[ancestor.len()] == b'/')
}

// ------------------------------------------------------------------------------------ tags

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: String,
    /// In the Built-in group (tags from Font Book and Typeface), not the user's own. Always the
    /// same as its top-level tag's.
    pub builtin: bool,
}

const TAG_COLUMNS: &str = "id, name, color, builtin";

fn tag_row(r: &rusqlite::Row) -> rusqlite::Result<Tag> {
    Ok(Tag { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, builtin: r.get(3)? })
}

/// Everything the UI needs to show tags and location colors.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Organize {
    pub tags: Vec<Tag>,
    /// Face key → ids of its tags.
    pub assignments: BTreeMap<String, Vec<i64>>,
    /// Location → color, for locations whose color the user changed.
    pub location_colors: BTreeMap<String, String>,
}

pub fn list_tags(conn: &Connection) -> AppResult<Vec<Tag>> {
    let mut stmt = conn.prepare(&format!("SELECT {TAG_COLUMNS} FROM tags ORDER BY name COLLATE NOCASE"))?;
    let rows = stmt.query_map([], tag_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn organize(conn: &Connection) -> AppResult<Organize> {
    let mut assignments: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    {
        let mut stmt = conn.prepare("SELECT face_key, tag_id FROM tag_fonts")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (key, tag) = row?;
            assignments.entry(key).or_default().push(tag);
        }
    }
    Ok(Organize { tags: list_tags(conn)?, assignments, location_colors: location_colors(conn)? })
}

pub fn get_tag(conn: &Connection, id: i64) -> AppResult<Tag> {
    conn.query_row(&format!("SELECT {TAG_COLUMNS} FROM tags WHERE id = ?1"), [id], tag_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("tag {id}")))
}

/// Finds a tag by name, ignoring letter case.
pub fn find_tag(conn: &Connection, name: &str) -> AppResult<Option<Tag>> {
    Ok(conn.query_row(&format!("SELECT {TAG_COLUMNS} FROM tags WHERE name = ?1"), [name], tag_row).optional()?)
}

/// The tag and every tag nested under it.
fn subtree(conn: &Connection, tag: &Tag) -> AppResult<Vec<Tag>> {
    Ok(list_tags(conn)?.into_iter().filter(|t| is_within(&t.name, &tag.name)).collect())
}

/// The color a new tag gets: the nearest existing parent's, or the least-used color among
/// top-level tags.
fn default_color(conn: &Connection, name: &str) -> AppResult<String> {
    for parent in parent_names(name).iter().rev() {
        if let Some(p) = find_tag(conn, parent)? {
            return Ok(p.color);
        }
    }
    let top: Vec<String> = list_tags(conn)?.into_iter().filter(|t| !t.name.contains('/')).map(|t| t.color).collect();
    Ok(colors::least_used(top.iter().map(String::as_str)).to_string())
}

fn check_color(color: &str) -> AppResult<()> {
    if colors::is_valid(color) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("Unknown color “{color}”")))
    }
}

/// Returns the tag with this (normalized) name, creating it and any missing parents first,
/// and how many tags were created. `color` is used for whatever is created; existing tags keep
/// their colors. Levels that already exist keep their spelling, so "sci-fi/Aliens" lands under
/// an existing "Sci-Fi".
///
/// `builtin` is the group of the top-level tag, used only if that has to be created. Every
/// level below it takes its parent's group, so a subtree is always in one group.
pub(crate) fn ensure_tag(tx: &Transaction, name: &str, color: &str, builtin: bool) -> AppResult<(Tag, usize)> {
    let mut path = String::new();
    let mut last: Option<Tag> = None;
    let mut created = 0;
    for level in name.split('/') {
        let wanted = if path.is_empty() { level.to_string() } else { format!("{path}/{level}") };
        match find_tag(tx, &wanted)? {
            Some(tag) => {
                path = tag.name.clone();
                last = Some(tag);
            }
            None => {
                let group = last.as_ref().map_or(builtin, |parent| parent.builtin);
                tx.execute(
                    "INSERT INTO tags (name, color, created_at, builtin) VALUES (?1, ?2, ?3, ?4)",
                    params![wanted, color, now(), group],
                )?;
                last = Some(Tag { id: tx.last_insert_rowid(), name: wanted.clone(), color: color.to_string(), builtin: group });
                created += 1;
                path = wanted;
            }
        }
    }
    last.map(|t| (t, created)).ok_or_else(|| AppError::Invalid("A tag needs a name".into()))
}

/// Makes a tag (and any missing parents). A new top-level tag is the user's own, whatever its
/// name; a nested one joins its parent's group.
pub fn create_tag(conn: &mut Connection, name: &str, color: Option<&str>) -> AppResult<Tag> {
    let name = with_existing_parents(conn, &normalize_name(name)?)?;
    if let Some(existing) = find_tag(conn, &name)? {
        return Err(AppError::Invalid(format!("There's already a tag called “{}”", existing.name)));
    }
    let color = match color {
        Some(c) => {
            check_color(c)?;
            c.to_string()
        }
        None => default_color(conn, &name)?,
    };
    let tx = conn.transaction()?;
    let (tag, _) = ensure_tag(&tx, &name, &color, false)?;
    tx.commit()?;
    Ok(tag)
}

/// Renames a tag. Tags nested under it move with it, and missing parents of the new name are
/// created. Refused if any resulting name is already taken by another tag.
///
/// Groups: moved under another tag, the tag and everything in it join that tag's group. At the
/// top level (renamed in place, or taken out of its parent) it keeps the group it had. Parents
/// created for the new name start in the tag's own group.
pub fn rename_tag(conn: &mut Connection, id: i64, new_name: &str) -> AppResult<Tag> {
    let tag = get_tag(conn, id)?;
    let new_name = with_existing_parents(conn, &normalize_name(new_name)?)?;
    if new_name == tag.name {
        return Ok(tag);
    }
    if !new_name.eq_ignore_ascii_case(&tag.name) && is_within(&new_name, &tag.name) {
        return Err(AppError::Invalid("A tag can't be moved inside itself".into()));
    }
    let moving = subtree(conn, &tag)?;
    let renamed: Vec<(i64, String)> =
        moving.iter().map(|t| (t.id, format!("{new_name}{}", &t.name[tag.name.len()..]))).collect();
    let moving_ids: BTreeSet<i64> = moving.iter().map(|t| t.id).collect();
    for (_, name) in &renamed {
        if name.chars().count() > MAX_NAME {
            return Err(AppError::Invalid(format!(
                "“{name}” would be longer than {MAX_NAME} characters. Choose a shorter name."
            )));
        }
        if let Some(other) = find_tag(conn, name)? {
            if !moving_ids.contains(&other.id) {
                return Err(AppError::Invalid(format!("There's already a tag called “{}”", other.name)));
            }
        }
    }
    // The group it ends up in: the new top-level tag's, if that's another tag that exists
    // already; otherwise (it is the top level, or the top level is about to be created for it)
    // its own.
    let builtin = match parent_names(&new_name).first() {
        Some(top) => find_tag(conn, top)?.filter(|t| !moving_ids.contains(&t.id)).map_or(tag.builtin, |t| t.builtin),
        None => tag.builtin,
    };
    let tx = conn.transaction()?;
    // Two steps, so names that swap within the subtree (only letter case can) never collide.
    for (id, _) in &renamed {
        tx.execute("UPDATE tags SET name = '\u{1}' || id WHERE id = ?1", [id])?;
    }
    for (id, name) in &renamed {
        tx.execute("UPDATE tags SET name = ?1, builtin = ?2 WHERE id = ?3", params![name, builtin, id])?;
    }
    if let Some(parent) = parent_names(&new_name).pop() {
        ensure_tag(&tx, &parent, &tag.color, builtin)?;
    }
    tx.commit()?;
    get_tag(conn, id)
}

pub fn set_tag_color(conn: &Connection, id: i64, color: &str) -> AppResult<()> {
    check_color(color)?;
    if conn.execute("UPDATE tags SET color = ?1 WHERE id = ?2", params![color, id])? == 0 {
        return Err(AppError::NotFound(format!("tag {id}")));
    }
    Ok(())
}

/// Deletes a tag and every tag nested under it. Returns the ids deleted.
pub fn delete_tag(conn: &mut Connection, id: i64) -> AppResult<Vec<i64>> {
    let tag = get_tag(conn, id)?;
    let ids: Vec<i64> = subtree(conn, &tag)?.into_iter().map(|t| t.id).collect();
    let tx = conn.transaction()?;
    for id in &ids {
        tx.execute("DELETE FROM tags WHERE id = ?1", [id])?;
    }
    tx.commit()?;
    Ok(ids)
}

/// Adds or removes tags on fonts, by face key. Removing also drops the loose key for the
/// same PostScript name, so a tag kept from an import comes off too. Returns rows changed.
pub fn assign(conn: &mut Connection, tag_ids: &[i64], keys: &[String], on: bool) -> AppResult<usize> {
    for key in keys {
        check_key(key)?;
    }
    let tx = conn.transaction()?;
    let mut changed = 0;
    for &tag in tag_ids {
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tags WHERE id = ?1)", [tag], |r| r.get(0))?;
        if !exists {
            return Err(AppError::NotFound(format!("tag {tag}")));
        }
        for key in keys {
            if on {
                changed += tx.execute(
                    "INSERT OR IGNORE INTO tag_fonts (tag_id, face_key, added_at) VALUES (?1, ?2, ?3)",
                    params![tag, key, now()],
                )?;
            } else {
                changed += tx.execute("DELETE FROM tag_fonts WHERE tag_id = ?1 AND face_key = ?2", params![tag, key])?;
                if let Some(ps) = key_postscript_name(key).filter(|_| !is_loose(key)) {
                    changed += tx.execute(
                        "DELETE FROM tag_fonts WHERE tag_id = ?1 AND face_key = ?2",
                        params![tag, loose_key(ps)],
                    )?;
                }
            }
        }
    }
    tx.commit()?;
    Ok(changed)
}

// ------------------------------------------------------------------------- location colors

/// A location is a folder path (a library folder or any folder inside one), or one of these.
pub const FONT_BOOK_LOCATION: &str = "fontbook";
pub const ADOBE_LOCATION: &str = "service:adobe";

pub fn location_colors(conn: &Connection) -> AppResult<BTreeMap<String, String>> {
    let mut stmt = conn.prepare("SELECT location, color FROM location_colors")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn check_location(location: &str) -> AppResult<()> {
    let path = (location.starts_with('/') || location.get(1..3) == Some(":\\")) && location.len() < 4096;
    if path || location == FONT_BOOK_LOCATION || location == ADOBE_LOCATION {
        Ok(())
    } else {
        Err(AppError::Invalid("That isn't a library location".into()))
    }
}

/// Sets a location's color, or with `None` goes back to its default.
pub fn set_location_color(conn: &Connection, location: &str, color: Option<&str>) -> AppResult<()> {
    check_location(location)?;
    match color {
        Some(c) => {
            check_color(c)?;
            conn.execute(
                "INSERT INTO location_colors (location, color) VALUES (?1, ?2)
                 ON CONFLICT(location) DO UPDATE SET color = excluded.color",
                params![location, c],
            )?;
        }
        None => {
            conn.execute("DELETE FROM location_colors WHERE location = ?1", [location])?;
        }
    }
    Ok(())
}

/// Sets a location's color only if it has none yet. Returns whether it was set.
pub fn set_location_color_if_unset(conn: &Connection, location: &str, color: &str) -> AppResult<bool> {
    check_location(location)?;
    check_color(color)?;
    Ok(conn.execute("INSERT OR IGNORE INTO location_colors (location, color) VALUES (?1, ?2)", params![location, color])? > 0)
}

// ---------------------------------------------------------------------------- the library

/// One style as the library knows it (all copies of a font), for matching imports and
/// describing exports.
#[derive(Debug, Clone)]
pub struct LibraryFace {
    pub key: String,
    pub postscript_name: Option<String>,
    pub family: String,
    pub style: String,
    pub variable: bool,
    pub italic: bool,
    /// Every copy.
    pub files: Vec<FontFile>,
    /// A copy lives in a macOS font folder.
    pub installed: bool,
}

#[derive(Debug, Clone)]
pub struct FontFile {
    pub path: String,
    /// Which face in the file (collections hold several).
    pub face_index: u32,
    /// In a macOS font folder.
    pub installed: bool,
}

/// The library grouped by face key, with lookups by PostScript name, family and file.
#[derive(Debug, Default)]
pub struct LibraryIndex {
    pub faces: Vec<LibraryFace>,
    by_key: HashMap<String, usize>,
    by_ps: HashMap<String, Vec<usize>>,
    by_family: HashMap<String, Vec<usize>>,
    by_path: HashMap<String, Vec<usize>>,
}

impl LibraryIndex {
    pub fn load(conn: &Connection) -> AppResult<Self> {
        let mut stmt = conn.prepare(
            "SELECT fonts.postscript_name, fonts.variable, fonts.italic, fonts.path, fonts.face_index, fonts.family,
                    fonts.subfamily, folders.kind = 'system'
             FROM fonts JOIN folders ON folders.id = fonts.folder_id
             ORDER BY fonts.path, fonts.face_index",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, bool>(1)?,
                r.get::<_, bool>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, u32>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, bool>(7)?,
            ))
        })?;
        let mut index = LibraryIndex::default();
        for row in rows {
            let (ps, variable, italic, path, face_index, family, style, installed) = row?;
            let ps = ps.filter(|p| !p.is_empty());
            let key = face_key(ps.as_deref(), variable, italic, &path, face_index);
            let i = match index.by_key.get(&key) {
                Some(&i) => i,
                None => {
                    index.faces.push(LibraryFace {
                        key: key.clone(),
                        postscript_name: ps.clone(),
                        family: family.clone(),
                        style,
                        variable,
                        italic,
                        files: Vec::new(),
                        installed: false,
                    });
                    let i = index.faces.len() - 1;
                    index.by_key.insert(key, i);
                    if let Some(ps) = &ps {
                        index.by_ps.entry(ps.clone()).or_default().push(i);
                    }
                    index.by_family.entry(family.to_lowercase()).or_default().push(i);
                    i
                }
            };
            let face = &mut index.faces[i];
            face.installed |= installed;
            face.files.push(FontFile { path: path.clone(), face_index, installed });
            let in_file = index.by_path.entry(path).or_default();
            if !in_file.contains(&i) {
                in_file.push(i);
            }
        }
        Ok(index)
    }

    pub fn by_key(&self, key: &str) -> Option<&LibraryFace> {
        self.by_key.get(key).map(|&i| &self.faces[i])
    }

    pub fn by_postscript_name(&self, ps: &str) -> impl Iterator<Item = &LibraryFace> {
        self.by_ps.get(ps).into_iter().flatten().map(|&i| &self.faces[i])
    }

    pub fn by_family(&self, family: &str) -> impl Iterator<Item = &LibraryFace> {
        self.by_family.get(&family.to_lowercase()).into_iter().flatten().map(|&i| &self.faces[i])
    }

    pub fn in_file(&self, path: &str) -> impl Iterator<Item = &LibraryFace> {
        self.by_path.get(path).into_iter().flatten().map(|&i| &self.faces[i])
    }

    /// Every library face a stored key stands for: one for a full or file key, all faces with
    /// that PostScript name for a loose key, none if the font isn't in the library.
    pub fn resolve(&self, key: &str) -> Vec<&LibraryFace> {
        if is_loose(key) {
            key_postscript_name(key).map(|ps| self.by_postscript_name(ps).collect()).unwrap_or_default()
        } else {
            self.by_key(key).into_iter().collect()
        }
    }

    pub fn paths(&self) -> impl Iterator<Item = &String> {
        self.by_path.keys()
    }
}

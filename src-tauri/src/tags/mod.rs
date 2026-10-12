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
//! **Schema.** These tables live outside the numbered migrations in db.rs, and PRAGMA
//! user_version is left alone, so other features can add tables without clashing.
//! `ensure_schema` creates whatever is missing and is safe to run at every launch. Add new
//! columns with `ensure_column`, never with a migration.

pub mod colors;
pub mod commands;
pub mod export;
pub mod import;
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
";

/// Creates the tag tables if they're missing. Idempotent; called once at launch, after db.rs
/// has migrated the library.
pub fn ensure_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

/// Adds a column if the table doesn't have it yet. `decl` is the column definition, such as
/// `"note TEXT"`. Use this for any later column, so libraries from either branch keep working.
#[allow(dead_code)]
pub fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> AppResult<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        params![table, column],
        |r| r.get(0),
    )?;
    if !exists {
        conn.execute_batch(&format!("ALTER TABLE \"{table}\" ADD COLUMN {decl};"))?;
    }
    Ok(())
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

fn check_key(key: &str) -> AppResult<()> {
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
    let mut stmt = conn.prepare("SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([], |r| Ok(Tag { id: r.get(0)?, name: r.get(1)?, color: r.get(2)? }))?;
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
    conn.query_row("SELECT id, name, color FROM tags WHERE id = ?1", [id], |r| {
        Ok(Tag { id: r.get(0)?, name: r.get(1)?, color: r.get(2)? })
    })
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("tag {id}")))
}

/// Finds a tag by name, ignoring letter case.
pub fn find_tag(conn: &Connection, name: &str) -> AppResult<Option<Tag>> {
    Ok(conn
        .query_row("SELECT id, name, color FROM tags WHERE name = ?1", [name], |r| {
            Ok(Tag { id: r.get(0)?, name: r.get(1)?, color: r.get(2)? })
        })
        .optional()?)
}

/// The tag and every tag nested under it.
fn subtree(conn: &Connection, tag: &Tag) -> AppResult<Vec<Tag>> {
    Ok(list_tags(conn)?.into_iter().filter(|t| is_within(&t.name, &tag.name)).collect())
}

/// The color a new tag gets: its parent's, or the least-used color among top-level tags.
fn default_color(conn: &Connection, name: &str) -> AppResult<String> {
    if let Some(parent) = parent_names(name).last() {
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

/// Returns the tag with this (normalized) name, creating it and any missing parents first.
/// `color` is used for whatever is created; existing tags keep their colors. Levels that
/// already exist keep their spelling, so "sci-fi/Aliens" lands under an existing "Sci-Fi".
pub(crate) fn ensure_tag(tx: &Transaction, name: &str, color: &str) -> AppResult<(Tag, bool)> {
    let mut path = String::new();
    let mut last = None;
    for level in name.split('/') {
        let wanted = if path.is_empty() { level.to_string() } else { format!("{path}/{level}") };
        match find_tag(tx, &wanted)? {
            Some(tag) => {
                path = tag.name.clone();
                last = Some((tag, false));
            }
            None => {
                tx.execute("INSERT INTO tags (name, color, created_at) VALUES (?1, ?2, ?3)", params![wanted, color, now()])?;
                last = Some((Tag { id: tx.last_insert_rowid(), name: wanted.clone(), color: color.to_string() }, true));
                path = wanted;
            }
        }
    }
    last.ok_or_else(|| AppError::Invalid("A tag needs a name".into()))
}

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
    let (tag, _) = ensure_tag(&tx, &name, &color)?;
    tx.commit()?;
    Ok(tag)
}

/// Renames a tag. Tags nested under it move with it, and missing parents of the new name are
/// created. Refused if any resulting name is already taken by another tag.
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
        if let Some(other) = find_tag(conn, name)? {
            if !moving_ids.contains(&other.id) {
                return Err(AppError::Invalid(format!("There's already a tag called “{}”", other.name)));
            }
        }
    }
    let tx = conn.transaction()?;
    // Two steps, so names that swap within the subtree (only letter case can) never collide.
    for (id, _) in &renamed {
        tx.execute("UPDATE tags SET name = '\u{1}' || id WHERE id = ?1", [id])?;
    }
    for (id, name) in &renamed {
        tx.execute("UPDATE tags SET name = ?1 WHERE id = ?2", params![name, id])?;
    }
    if let Some(parent) = parent_names(&new_name).pop() {
        ensure_tag(&tx, &parent, &tag.color)?;
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
            face.files.push(FontFile { path: path.clone(), installed });
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

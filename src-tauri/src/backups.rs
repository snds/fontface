//! Tag backups: copies of every tag in Fontface's own tags file format (the same file
//! "Export tags…" writes as JSON, which imports back), kept in `<app data>/Backups/`.
//!
//! - At launch, if backups are on, there's at least one tag, and the newest backup is a day old
//!   (or there's none), a new one is written. "Back up now" writes one whenever asked.
//! - Names sort by time: `Tags 2026-10-12 14-30-05.json`. The time is UTC, so names never
//!   repeat or go backwards when the clocks change. The UI shows local times.
//! - After writing, the oldest backups beyond the number to keep are deleted, never the one just
//!   written. One dated a day or more ahead (the clock was wrong) goes first. Only files whose
//!   names match that pattern exactly are ever counted or deleted; anything else in the folder
//!   is left alone.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{de::IgnoredAny, Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    tags::export,
};

pub const FOLDER: &str = "Backups";
const PREFIX: &str = "Tags ";
const EXTENSION: &str = ".json";
/// How old the newest backup must be before launch writes another.
pub const INTERVAL_SECS: i64 = 24 * 60 * 60;
/// Larger files aren't read to count their tags.
const MAX_READ: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub path: String,
    /// Unix time in milliseconds.
    pub created_at: i64,
    pub tags: usize,
    pub bytes: u64,
}

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join(FOLDER)
}

/// Unix seconds → "Tags 2026-10-12 14-30-05.json" (UTC).
pub fn file_name(secs: i64) -> String {
    let iso = export::iso8601(secs); // 2026-10-12T14:30:05Z
    format!("{PREFIX}{} {}{EXTENSION}", &iso[..10], iso[11..19].replace(':', "-"))
}

/// The time in a backup's name, or `None` if the name isn't exactly a backup name.
pub fn parse_name(name: &str) -> Option<i64> {
    let stamp = name.strip_prefix(PREFIX)?.strip_suffix(EXTENSION)?;
    let b = stamp.as_bytes();
    if b.len() != 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b' ' || b[13] != b'-' || b[16] != b'-' {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = &stamp[range];
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok()).flatten()
    };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let secs = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;
    // Writing it back must give the same name, which rules out "2026-02-31" and "25-61-61".
    (file_name(secs) == name).then_some(secs)
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm; the inverse of the one in `iso8601`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Backups in the folder (by name), newest first, without reading them.
fn entries(dir: &Path) -> Vec<(i64, PathBuf, u64)> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<(i64, PathBuf, u64)> = read
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let secs = parse_name(e.file_name().to_str()?)?;
            Some((secs, e.path(), e.metadata().map(|m| m.len()).unwrap_or(0)))
        })
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    out
}

/// How many tags a backup holds, or 0 if it can't be read. Only the tag list is counted; the
/// fonts inside are skipped without being kept.
fn count_tags(path: &Path) -> usize {
    #[derive(Deserialize)]
    struct Head {
        format: String,
        tags: Vec<IgnoredAny>,
    }
    let Ok(file) = std::fs::File::open(path) else { return 0 };
    if file.metadata().map(|m| m.len()).unwrap_or(u64::MAX) > MAX_READ {
        return 0;
    }
    match serde_json::from_reader::<_, Head>(std::io::BufReader::new(file)) {
        Ok(head) if head.format == export::JSON_FORMAT => head.tags.len(),
        _ => 0,
    }
}

/// Every backup, newest first.
pub fn list(dir: &Path) -> Vec<Backup> {
    entries(dir)
        .into_iter()
        .map(|(secs, path, bytes)| Backup {
            tags: count_tags(&path),
            path: path.to_string_lossy().into_owned(),
            created_at: secs * 1000,
            bytes,
        })
        .collect()
}

/// The newest backup's time, if there is one.
pub fn newest(dir: &Path) -> Option<i64> {
    entries(dir).first().map(|(secs, _, _)| *secs)
}

/// True when launch should write a backup: there are tags, and the newest backup is at least a
/// day old, or there's none. A backup dated more than a day ahead (the clock was wrong when it
/// was written) doesn't hold new ones back.
pub fn due(dir: &Path, now: i64, has_tags: bool) -> bool {
    has_tags && newest(dir).is_none_or(|t| now - t >= INTERVAL_SECS || t - now >= INTERVAL_SECS)
}

/// Deletes the oldest backups beyond `keep`. Returns how many were deleted. `just_written` is
/// always kept. A backup dated a day or more after `now` (the clock was wrong when it was
/// written) counts as older than every other, so it can't push out real ones.
pub fn rotate(dir: &Path, keep: usize, now: i64, just_written: Option<&Path>) -> usize {
    let mut entries = entries(dir);
    // A stable sort, so each group stays newest first.
    entries.sort_by_key(|(secs, path, _)| (Some(path.as_path()) != just_written, secs - now >= INTERVAL_SECS));
    let mut removed = 0;
    for (_, path, _) in entries.into_iter().skip(keep.max(1)) {
        match std::fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(e) => eprintln!("fontface: couldn't delete old backup {}: {e}", path.display()),
        }
    }
    removed
}

pub fn has_tags(conn: &Connection) -> AppResult<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM tags)", [], |r| r.get(0))?)
}

/// The backup's contents and how many tags it holds. Reads the database only; run it with the
/// DB lock, then `write` without it.
pub fn snapshot(conn: &Connection, now: i64) -> AppResult<(String, usize)> {
    let tags = export::collect(conn, None)?;
    if tags.is_empty() {
        return Err(AppError::Invalid("There are no tags to back up yet".into()));
    }
    let count = tags.len();
    Ok((export::to_json(conn, tags, now)?, count))
}

/// Writes a backup made by `snapshot`, then deletes the oldest beyond `keep` (never this one).
pub fn write(dir: &Path, now: i64, contents: &str, tags: usize, keep: usize) -> AppResult<Backup> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(file_name(now));
    export::write_file(&path, contents)?;
    rotate(dir, keep, now, Some(&path));
    Ok(Backup { path: path.to_string_lossy().into_owned(), created_at: now * 1000, tags, bytes: contents.len() as u64 })
}

/// The launch backup: writes one if it's due (see `due`). Returns it, or `None` if none was needed.
pub fn at_launch(conn: &Connection, dir: &Path, now: i64, keep: usize) -> AppResult<Option<Backup>> {
    if !due(dir, now, has_tags(conn)?) {
        return Ok(None);
    }
    let (contents, tags) = snapshot(conn, now)?;
    write(dir, now, &contents, tags, keep).map(Some)
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

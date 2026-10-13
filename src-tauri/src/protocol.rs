//! `ff://` — serves font bytes to the web view by library id, for previews.
//! Only fonts in the database can be served, so the UI never gets general file access.
//! The UI builds URLs with `convertFileSrc(id, "ff")`, which handles the
//! macOS (`ff://localhost/12`) vs Windows (`http://ff.localhost/12`) difference.
//!
//! Previews must never stall or balloon:
//! - Online-only cloud files aren't downloaded for a preview: the read fails fast and the UI
//!   is told "not downloaded" (503).
//! - Files over `MAX_PREVIEW_BYTES` aren't sent (413).
//! - The last collection file read is kept, so previewing its faces one after another doesn't
//!   re-read the whole .ttc for each face.

use std::sync::Mutex;

use tauri::{
    http::{header, Request, Response, StatusCode},
    AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder,
};

use crate::{cloud, sfnt, AppState};

pub(crate) const MAX_PREVIEW_BYTES: u64 = 96 * 1024 * 1024;

/// (path, mtime, size) → bytes of the most recently read collection file.
static LAST_COLLECTION: Mutex<Option<((String, i64, i64), std::sync::Arc<Vec<u8>>)>> = Mutex::new(None);
/// Held while a collection file is checked in the cache and read, so faces requested together
/// wait for one read instead of each reading the whole file.
static COLLECTION_READ: Mutex<()> = Mutex::new(());

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let id = request.uri().path().trim_start_matches('/').to_string();
    std::thread::spawn(move || {
        cloud::fail_fast_on_this_thread();
        let response = match load(&app, &id) {
            Ok((bytes, mime)) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(bytes),
            Err(status) => Response::builder()
                .status(status)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Vec::new()),
        };
        responder.respond(response.expect("static response parts are valid"));
    });
}

fn read_file(path: &str) -> Result<Vec<u8>, StatusCode> {
    let size = std::fs::metadata(path).map_err(|_| StatusCode::NOT_FOUND)?.len();
    if size > MAX_PREVIEW_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    std::fs::read(path).map_err(|e| {
        if cloud::is_not_downloaded(&e) {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::NOT_FOUND
        }
    })
}

fn load<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(Vec<u8>, &'static str), StatusCode> {
    let id: i64 = id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    let state = app.state::<AppState>();
    let (path, face_index, mtime, size): (String, u32, i64, i64) = {
        let conn = state.conn().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        conn.query_row(
            "SELECT path, face_index, mtime, file_size FROM fonts WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| StatusCode::NOT_FOUND)?
    };
    // Never serve Creative Cloud's font files (Adobe's terms). They aren't scanned, so this is a backstop.
    if crate::services::adobe::is_adobe_path(std::path::Path::new(&path)) {
        return Err(StatusCode::FORBIDDEN);
    }
    let key = (path.clone(), mtime, size);
    let lower = path.to_ascii_lowercase();
    let collection = lower.ends_with(".ttc") || lower.ends_with(".otc") || face_index > 0;
    let _reading = collection.then(|| COLLECTION_READ.lock().unwrap_or_else(|p| p.into_inner()));
    let cached = LAST_COLLECTION.lock().ok().and_then(|c| c.as_ref().filter(|(k, _)| *k == key).map(|(_, b)| b.clone()));
    let data = match cached {
        Some(bytes) => bytes,
        None => {
            let bytes = std::sync::Arc::new(read_file(&path)?);
            if sfnt::is_collection(&bytes) {
                if let Ok(mut slot) = LAST_COLLECTION.lock() {
                    *slot = Some((key, bytes.clone()));
                }
            }
            bytes
        }
    };
    drop(_reading);
    let data = if sfnt::is_collection(&data) {
        sfnt::extract_face(&data, face_index).ok_or(StatusCode::UNPROCESSABLE_ENTITY)?
    } else {
        std::sync::Arc::try_unwrap(data).unwrap_or_else(|shared| shared.to_vec())
    };
    let mime = if data.starts_with(b"OTTO") { "font/otf" } else { "font/ttf" };
    Ok((data, mime))
}

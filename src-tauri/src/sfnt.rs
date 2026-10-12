//! Pulls one face out of a font collection (.ttc/.otc) as a standalone font file.
//! Web views can't pick a face inside a collection, so previews need this.
//! The OS activation path never uses it: CoreText registers collections directly.

fn u16_at(d: &[u8], o: usize) -> Option<u16> {
    d.get(o..o + 2).map(|b| u16::from_be_bytes([b[0], b[1]]))
}

fn u32_at(d: &[u8], o: usize) -> Option<u32> {
    d.get(o..o + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

pub fn is_collection(data: &[u8]) -> bool {
    data.starts_with(b"ttcf")
}

pub fn extract_face(data: &[u8], index: u32) -> Option<Vec<u8>> {
    if !is_collection(data) {
        return None;
    }
    let num_fonts = u32_at(data, 8)?;
    if index >= num_fonts {
        return None;
    }
    let dir = u32_at(data, 12 + 4 * index as usize)? as usize;
    let sfnt_version = u32_at(data, dir)?;
    let num_tables = u16_at(data, dir + 4)? as usize;

    let mut records = Vec::with_capacity(num_tables);
    for i in 0..num_tables {
        let r = dir + 12 + 16 * i;
        let (tag, checksum, offset, length) = (u32_at(data, r)?, u32_at(data, r + 4)?, u32_at(data, r + 8)?, u32_at(data, r + 12)?);
        data.get(offset as usize..offset as usize + length as usize)?;
        records.push((tag, checksum, offset as usize, length as usize));
    }

    let header_len = 12 + 16 * num_tables;
    let mut out = Vec::with_capacity(header_len + records.iter().map(|r| r.3 + 3).sum::<usize>());
    let entry_selector = (num_tables.max(1) as f64).log2().floor() as u16;
    let search_range = (1u16 << entry_selector) * 16;
    out.extend_from_slice(&sfnt_version.to_be_bytes());
    out.extend_from_slice(&(num_tables as u16).to_be_bytes());
    out.extend_from_slice(&search_range.to_be_bytes());
    out.extend_from_slice(&entry_selector.to_be_bytes());
    out.extend_from_slice(&((num_tables as u16 * 16).saturating_sub(search_range)).to_be_bytes());

    let mut next = header_len;
    for &(tag, checksum, _, length) in &records {
        out.extend_from_slice(&tag.to_be_bytes());
        out.extend_from_slice(&checksum.to_be_bytes());
        out.extend_from_slice(&(next as u32).to_be_bytes());
        out.extend_from_slice(&(length as u32).to_be_bytes());
        next += (length + 3) & !3;
    }
    for &(_, _, offset, length) in &records {
        out.extend_from_slice(&data[offset..offset + length]);
        out.resize((out.len() + 3) & !3, 0);
    }
    Some(out)
}

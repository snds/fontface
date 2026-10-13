#!/usr/bin/env python3
"""Generates src-tauri/src/preview/unicode.rs: Unicode block ranges and the code points a
preview sample skips. Runs offline.

    python3 -I src-tauri/scripts/gen_unicode.py [path/to/Blocks.txt] > src-tauri/src/preview/unicode.rs

Sources:
- Blocks: the Unicode Character Database's Blocks.txt. macOS ships version 13.0 of it with Perl
  (/System/Library/Perl/5.*/unicore/Blocks.txt), which is the default. Blocks added or changed
  in Unicode 14.0 to 16.0 are listed by hand below (from the Unicode 14.0, 15.0, 15.1 and 16.0
  release notes). A newer Blocks.txt passed on the command line makes that list a no-op.
- Character categories: Python's own unicodedata module (its version is recorded in the
  output). It has no block data, which is why Blocks.txt is still needed.

The script checks its own result: blocks are sorted and don't overlap, every assigned code
point in Python's Unicode version lies in some block, and each hand-added block's first
assigned character is named after the block's script.
"""

import glob
import sys
import unicodedata

# Blocks added after Unicode 13.0, or 13.0 blocks whose range grew: (start, end, name, a word
# the first assigned character's name must contain, as a hand check).
LATER_BLOCKS = [
    # 14.0
    (0x0870, 0x089F, "Arabic Extended-B", "ARABIC"),
    (0x10570, 0x105BF, "Vithkuqi", "VITHKUQI"),
    (0x10780, 0x107BF, "Latin Extended-F", "MODIFIER LETTER"),
    (0x10F70, 0x10FAF, "Old Uyghur", "OLD UYGHUR"),
    (0x11700, 0x1174F, "Ahom", "AHOM"),  # was 11700..1173F
    (0x11AB0, 0x11ABF, "Unified Canadian Aboriginal Syllabics Extended-A", "CANADIAN SYLLABICS"),
    (0x12F90, 0x12FFF, "Cypro-Minoan", "CYPRO-MINOAN"),
    (0x16A70, 0x16ACF, "Tangsa", "TANGSA"),
    (0x1AFF0, 0x1AFFF, "Kana Extended-B", "KATAKANA"),
    (0x1CF00, 0x1CFCF, "Znamenny Musical Notation", "ZNAMENNY"),
    (0x1DF00, 0x1DFFF, "Latin Extended-G", "LATIN"),
    (0x1E290, 0x1E2BF, "Toto", "TOTO"),
    (0x1E7E0, 0x1E7FF, "Ethiopic Extended-B", "ETHIOPIC"),
    # 15.0
    (0x10EC0, 0x10EFF, "Arabic Extended-C", "ARABIC"),
    (0x11B00, 0x11B5F, "Devanagari Extended-A", "DEVANAGARI"),
    (0x11F00, 0x11F5F, "Kawi", "KAWI"),
    (0x13430, 0x1345F, "Egyptian Hieroglyph Format Controls", "EGYPTIAN HIEROGLYPH"),  # was 13430..1343F
    (0x1D2C0, 0x1D2DF, "Kaktovik Numerals", "KAKTOVIK"),
    (0x1E030, 0x1E08F, "Cyrillic Extended-D", "MODIFIER LETTER CYRILLIC"),
    (0x1E4D0, 0x1E4FF, "Nag Mundari", "NAG MUNDARI"),
    (0x31350, 0x323AF, "CJK Unified Ideographs Extension H", "CJK UNIFIED IDEOGRAPH"),
    # 15.1
    (0x2EBF0, 0x2EE5F, "CJK Unified Ideographs Extension I", "CJK UNIFIED IDEOGRAPH"),
    # 16.0
    (0x105C0, 0x105FF, "Todhri", "TODHRI"),
    (0x10D40, 0x10D8F, "Garay", "GARAY"),
    (0x11380, 0x113FF, "Tulu-Tigalari", "TULU-TIGALARI"),
    (0x116D0, 0x116FF, "Myanmar Extended-C", "MYANMAR"),
    (0x11BC0, 0x11BFF, "Sunuwar", "SUNUWAR"),
    (0x13460, 0x143FF, "Egyptian Hieroglyphs Extended-A", "EGYPTIAN HIEROGLYPH"),
    (0x16100, 0x1613F, "Gurung Khema", "GURUNG KHEMA"),
    (0x16D40, 0x16D7F, "Kirat Rai", "KIRAT RAI"),
    (0x1CC00, 0x1CEBF, "Symbols for Legacy Computing Supplement", ""),
    (0x1E5D0, 0x1E5FF, "Ol Onal", "OL ONAL"),
]

# Invisible or not drawable on their own: controls, format characters, separators, surrogates.
INVISIBLE_CATEGORIES = {"Cc", "Cf", "Zs", "Zl", "Zp", "Cs"}
# Marks only make sense on a base letter, so a sample leaves them out too.
MARK_CATEGORIES = {"Mn", "Mc", "Me"}


def default_blocks_txt():
    found = sorted(glob.glob("/System/Library/Perl/5.*/unicore/Blocks.txt"))
    if not found:
        sys.exit("No Blocks.txt found; pass its path as the first argument.")
    return found[-1]


def read_blocks(path):
    version = "?"
    blocks = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("# Blocks-"):
                version = line[len("# Blocks-"):].strip().removesuffix(".txt")
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            rng, name = (s.strip() for s in line.split(";", 1))
            a, b = (int(x, 16) for x in rng.split(".."))
            blocks[name] = (a, b)
    return version, blocks


def is_noncharacter(cp):
    return 0xFDD0 <= cp <= 0xFDEF or (cp & 0xFFFE) == 0xFFFE


def ranges(pred):
    out = []
    start = None
    for cp in range(0x110000 + 1):
        hit = cp <= 0x10FFFF and pred(cp)
        if hit and start is None:
            start = cp
        elif not hit and start is not None:
            out.append((start, cp - 1))
            start = None
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else default_blocks_txt()
    file_version, blocks = read_blocks(path)
    for a, b, name, word in LATER_BLOCKS:
        blocks[name] = (a, b)  # adds, or widens a 13.0 range
        first = next((cp for cp in range(a, b + 1) if unicodedata.category(chr(cp)) != "Cn"), None)
        assert first is not None, f"{name}: nothing assigned in Python's Unicode {unicodedata.unidata_version}"
        assert word in unicodedata.name(chr(first), ""), f"{name}: U+{first:04X} is {unicodedata.name(chr(first), '?')}"
    ordered = sorted((a, b, name) for name, (a, b) in blocks.items())
    for (a1, b1, n1), (a2, _, n2) in zip(ordered, ordered[1:]):
        assert b1 < a2, f"{n1} overlaps {n2}"
    starts = [a for a, _, _ in ordered]
    import bisect

    def block_of(cp):
        i = bisect.bisect_right(starts, cp) - 1
        return ordered[i][2] if i >= 0 and cp <= ordered[i][1] else None

    for cp in range(0x110000):
        if unicodedata.category(chr(cp)) not in ("Cn", "Co", "Cs") and block_of(cp) is None:
            sys.exit(f"U+{cp:04X} ({unicodedata.name(chr(cp), '?')}) is assigned but in no block; update LATER_BLOCKS")

    def invisible(cp):
        cat = unicodedata.category(chr(cp))
        return cat in INVISIBLE_CATEGORIES or is_noncharacter(cp) or 0xFE00 <= cp <= 0xFE0F or 0xE0100 <= cp <= 0xE01EF

    def skip(cp):
        return invisible(cp) or unicodedata.category(chr(cp)) in MARK_CATEGORIES

    out = []
    w = out.append
    w("//! Unicode tables for previews. Generated by src-tauri/scripts/gen_unicode.py; don't edit by hand.")
    w(f"//! Blocks: Blocks.txt {file_version} plus the blocks added in Unicode 14.0 to 16.0 (listed in the script).")
    w(f"//! Categories: Python {sys.version_info.major}.{sys.version_info.minor} unicodedata {unicodedata.unidata_version}.")
    w("")
    w("/// Unicode blocks as (first, last, name), sorted by first code point.")
    w("pub const BLOCKS: &[(u32, u32, &str)] = &[")
    for a, b, name in ordered:
        w(f'    (0x{a:04X}, 0x{b:04X}, "{name}"),')
    w("];")
    w("")
    w("/// Code points a preview sample leaves out, as sorted (first, last) ranges: controls, format")
    w("/// characters, spaces and other separators, surrogates, marks, variation selectors and")
    w("/// noncharacters.")
    w("pub const SKIP: &[(u32, u32)] = &[")
    for a, b in ranges(skip):
        w(f"    (0x{a:04X}, 0x{b:04X}),")
    w("];")
    w("")
    w("/// The invisible subset of SKIP (everything but marks): never shown in the character grid.")
    w("pub const INVISIBLE: &[(u32, u32)] = &[")
    for a, b in ranges(invisible):
        w(f"    (0x{a:04X}, 0x{b:04X}),")
    w("];")
    sys.stdout.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main()

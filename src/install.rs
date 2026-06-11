//! `chessai install` — lay down the Claude Code chess skill (and its Node tools)
//! so the game can be driven from `/chess`, without the plugin marketplace.
//!
//! Everything is embedded in the binary, so this works regardless of how chessai
//! itself was installed (cargo / npx / curl). The binary's ONLY job is to be a
//! self-contained distribution vehicle for these files.

use std::fs;
use std::path::{Path, PathBuf};

const SKILL_MD: &str = include_str!("../assets/skill/SKILL.md");
const TOOL_SERVER: &str = include_str!("../assets/skill/tools/server.cjs");
const TOOL_BOARD: &str = include_str!("../assets/skill/tools/board.html");
const TOOL_API: &str = include_str!("../assets/skill/tools/chess-api.cjs");

fn home_dir() -> Option<PathBuf> {
    for var in ["HOME", "USERPROFILE"] {
        if let Ok(h) = std::env::var(var) {
            if !h.is_empty() {
                return Some(PathBuf::from(h));
            }
        }
    }
    None
}

fn write_file(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    println!("  wrote {}", path.display());
    Ok(())
}

pub fn run() -> std::io::Result<()> {
    let home = home_dir().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "could not resolve home directory")
    })?;
    let chess = home.join(".claude").join("skills").join("chess");

    println!("Installing the chess skill into {}", chess.display());

    write_file(&chess.join("SKILL.md"), SKILL_MD)?;
    write_file(&chess.join("tools").join("server.cjs"), TOOL_SERVER)?;
    write_file(&chess.join("tools").join("board.html"), TOOL_BOARD)?;
    write_file(&chess.join("tools").join("chess-api.cjs"), TOOL_API)?;

    println!("\nDone. Requires Node.js on PATH (the server + tools are Node).");
    println!("Inside Claude Code, start a game with:  /chess");
    println!("Or run the board manually:  node {}/tools/server.cjs --open", chess.display());
    Ok(())
}

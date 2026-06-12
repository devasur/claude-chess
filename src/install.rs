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

// The AI-opponent agent. Installed into ~/.claude/agents (NOT the skill dir) so
// the Agent tool can resolve `subagent_type: "chess-ai"`. Restricting it to
// `tools: [Bash]` is what keeps the per-call tool-schema tax minimal.
const AGENT_AI: &str = include_str!("../assets/skill/agents/chess-ai.md");

// Web board assets (split out of board.html): served from tools/web by server.cjs.
// (path-in-skill, contents) — laid down under <skill>/tools/web/.
const WEB_ASSETS: &[(&str, &str)] = &[
    ("theme.css", include_str!("../assets/skill/tools/web/theme.css")),
    ("board.css", include_str!("../assets/skill/tools/web/board.css")),
    ("engine.js", include_str!("../assets/skill/tools/web/engine.js")),
    ("api.js", include_str!("../assets/skill/tools/web/api.js")),
    ("view.js", include_str!("../assets/skill/tools/web/view.js")),
    ("app.js", include_str!("../assets/skill/tools/web/app.js")),
];

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
    for (name, contents) in WEB_ASSETS {
        write_file(&chess.join("tools").join("web").join(name), contents)?;
    }

    // The AI-opponent agent lives under ~/.claude/agents so the Agent tool can
    // find it by subagent_type, independent of the skill directory.
    let agents = home.join(".claude").join("agents");
    write_file(&agents.join("chess-ai.md"), AGENT_AI)?;
    // Clean up the pre-rename agent file, if present.
    let _ = fs::remove_file(agents.join("chess-player.md"));

    // Remove the legacy v0.1.x workflow, if a previous install left one behind.
    let legacy = home.join(".claude").join("workflows").join("chessai.cjs");
    if legacy.exists() {
        let _ = fs::remove_file(&legacy);
        println!("  removed legacy {}", legacy.display());
    }

    println!("\nDone. Requires Node.js on PATH (the server + tools are Node).");
    println!("Inside Claude Code, start a game with:  /chess");
    println!("Or run the board manually:  node {}/tools/server.cjs --open", chess.display());
    Ok(())
}

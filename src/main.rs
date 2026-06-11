//! chessai — installer / distribution vehicle for the Claude Code chess skill.
//!
//! The game itself (server, board logic, REST API, web UI) lives in the skill's
//! Node tools; the black player is a Claude agent the skill spawns. This binary
//! exists only to drop those files into ~/.claude/skills/chess without needing
//! the plugin marketplace.
//!
//!   chessai install            install the /chess skill + Node tools
//!   chessai --version | --help

mod install;

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn print_help() {
    println!(
        "chessai {}\n\n\
A tiny installer for the Claude Code chess skill (no marketplace required).\n\n\
USAGE:\n\
    chessai install     Install the /chess skill and its Node tools into ~/.claude/skills/chess\n\
    chessai --version   Print version\n\
    chessai --help      Show this help\n\n\
After installing, run /chess inside Claude Code. Requires Node.js on PATH.\n",
        env!("CARGO_PKG_VERSION")
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if has_flag(&args, "--version") || has_flag(&args, "-V") {
        println!("chessai {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let result = match args.first().map(|s| s.as_str()) {
        Some("install") => install::run(),
        _ => {
            print_help();
            Ok(())
        }
    };

    if let Err(e) = result {
        eprintln!("chessai: error: {e}");
        std::process::exit(1);
    }
}

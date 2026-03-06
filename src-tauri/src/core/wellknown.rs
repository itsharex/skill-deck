//! Well-Known Skills protocol support (RFC 8615 `.well-known/skills`).
//!
//! Implements discovery of skills hosted under the `.well-known/skills/` path
//! on websites. This is the Rust equivalent of the CLI's `providers/wellknown.ts`.

use crate::error::AppError;
use serde::Deserialize;
use std::path::PathBuf;
use url::Url;

const WELL_KNOWN_PATH: &str = ".well-known/skills";
const INDEX_FILE: &str = "index.json";

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct WellKnownIndex {
    pub skills: Vec<WellKnownSkillEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WellKnownSkillEntry {
    pub name: String,
    pub description: String,
    pub files: Vec<String>,
}

/// Result of a successful well-known skill fetch — carries the local path
/// where files were downloaded and an identifier suitable for lock-file storage.
#[derive(Debug, Clone)]
pub struct WellKnownFetchResult {
    pub repo_path: PathBuf,
    pub source_identifier: String,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

struct IndexUrlCandidate {
    index_url: String,
    base_url: String,
}

/// Extract the hostname from a URL, stripping a leading `www.` prefix.
pub fn extract_hostname(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    let stripped = host.strip_prefix("www.").unwrap_or(host);
    Some(stripped.to_string())
}

/// Build candidate index URLs for a given page URL.
///
/// For a URL with a non-trivial path (e.g. `https://example.com/docs`) we
/// return two candidates:
///   1. Path-relative: `https://example.com/docs/.well-known/skills/index.json`
///   2. Root fallback: `https://example.com/.well-known/skills/index.json`
///
/// For a root URL (`https://example.com` or `https://example.com/`) only the
/// root candidate is returned.
fn build_index_urls(url: &str) -> Vec<IndexUrlCandidate> {
    let Ok(parsed) = Url::parse(url) else {
        return vec![];
    };

    let origin = parsed.origin().ascii_serialization();
    let path = parsed.path().trim_end_matches('/');

    let root_candidate = IndexUrlCandidate {
        index_url: format!("{origin}/{WELL_KNOWN_PATH}/{INDEX_FILE}"),
        base_url: format!("{origin}/{WELL_KNOWN_PATH}"),
    };

    if path.is_empty() {
        return vec![root_candidate];
    }

    let path_candidate = IndexUrlCandidate {
        index_url: format!("{origin}{path}/{WELL_KNOWN_PATH}/{INDEX_FILE}"),
        base_url: format!("{origin}{path}/{WELL_KNOWN_PATH}"),
    };

    vec![path_candidate, root_candidate]
}

/// Validate a single skill entry from the index.
fn validate_skill_entry(entry: &WellKnownSkillEntry) -> Result<(), AppError> {
    if entry.name.trim().is_empty() {
        return Err(AppError::InvalidSource {
            value: "Skill name must not be empty".into(),
        });
    }
    if entry.description.trim().is_empty() {
        return Err(AppError::InvalidSource {
            value: "Skill description must not be empty".into(),
        });
    }

    let has_skill_md = entry
        .files
        .iter()
        .any(|f| f.eq_ignore_ascii_case("SKILL.md"));
    if !has_skill_md {
        return Err(AppError::InvalidSource {
            value: format!(
                "Skill '{}' must include SKILL.md in its files list",
                entry.name
            ),
        });
    }

    for file in &entry.files {
        if file.trim().is_empty() {
            return Err(AppError::InvalidSource {
                value: "Empty filename not allowed".into(),
            });
        }
        if file.starts_with('/') || file.starts_with('\\') {
            return Err(AppError::InvalidSource {
                value: format!("Absolute path not allowed: {file}"),
            });
        }
        let normalized = file.replace('\\', "/");
        if normalized.split('/').any(|seg| seg == "..") {
            return Err(AppError::InvalidSource {
                value: format!("Path traversal not allowed: {file}"),
            });
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_valid_index() {
        let json = r#"{ "skills": [{ "name": "my-skill", "description": "A skill", "files": ["SKILL.md"] }] }"#;
        let index: WellKnownIndex = serde_json::from_str(json).unwrap();
        assert_eq!(index.skills.len(), 1);
        assert_eq!(index.skills[0].name, "my-skill");
        assert_eq!(index.skills[0].files, vec!["SKILL.md"]);
    }

    #[test]
    fn test_parse_index_multiple_skills() {
        let json = r#"{
            "skills": [
                { "name": "alpha", "description": "First", "files": ["SKILL.md", "lib.py"] },
                { "name": "beta", "description": "Second", "files": ["SKILL.md"] }
            ]
        }"#;
        let index: WellKnownIndex = serde_json::from_str(json).unwrap();
        assert_eq!(index.skills.len(), 2);
        assert_eq!(index.skills[0].name, "alpha");
        assert_eq!(index.skills[1].name, "beta");
    }

    #[test]
    fn test_validate_entry_valid() {
        let entry = WellKnownSkillEntry {
            name: "good-skill".into(),
            description: "Does things".into(),
            files: vec!["SKILL.md".into(), "utils.py".into()],
        };
        assert!(validate_skill_entry(&entry).is_ok());
    }

    #[test]
    fn test_validate_entry_missing_skill_md() {
        let entry = WellKnownSkillEntry {
            name: "bad-skill".into(),
            description: "Missing SKILL.md".into(),
            files: vec!["README.md".into()],
        };
        assert!(validate_skill_entry(&entry).is_err());
    }

    #[test]
    fn test_validate_entry_path_traversal() {
        let entry = WellKnownSkillEntry {
            name: "evil".into(),
            description: "Traversal".into(),
            files: vec!["SKILL.md".into(), "../etc/passwd".into()],
        };
        let err = validate_skill_entry(&entry).unwrap_err();
        assert!(err.to_string().contains("Path traversal"));
    }

    #[test]
    fn test_validate_entry_path_traversal_no_false_positive() {
        let entry = WellKnownSkillEntry {
            name: "ok".into(),
            description: "Has double-dot in filename".into(),
            files: vec!["SKILL.md".into(), "my..file.txt".into()],
        };
        assert!(validate_skill_entry(&entry).is_ok());
    }

    #[test]
    fn test_validate_entry_absolute_path() {
        let entry = WellKnownSkillEntry {
            name: "evil".into(),
            description: "Absolute".into(),
            files: vec!["SKILL.md".into(), "/etc/passwd".into()],
        };
        let err = validate_skill_entry(&entry).unwrap_err();
        assert!(err.to_string().contains("Absolute path"));
    }

    #[test]
    fn test_validate_entry_empty_name() {
        let entry = WellKnownSkillEntry {
            name: "  ".into(),
            description: "Has description".into(),
            files: vec!["SKILL.md".into()],
        };
        let err = validate_skill_entry(&entry).unwrap_err();
        assert!(err.to_string().contains("name must not be empty"));
    }

    #[test]
    fn test_validate_entry_empty_description() {
        let entry = WellKnownSkillEntry {
            name: "some-skill".into(),
            description: "".into(),
            files: vec!["SKILL.md".into()],
        };
        let err = validate_skill_entry(&entry).unwrap_err();
        assert!(err.to_string().contains("description must not be empty"));
    }

    #[test]
    fn test_validate_entry_empty_filename() {
        let entry = WellKnownSkillEntry {
            name: "bad".into(),
            description: "Has empty filename".into(),
            files: vec!["SKILL.md".into(), "  ".into()],
        };
        let err = validate_skill_entry(&entry).unwrap_err();
        assert!(err.to_string().contains("Empty filename"));
    }

    #[test]
    fn test_extract_hostname_basic() {
        assert_eq!(
            extract_hostname("https://mintlify.com/docs"),
            Some("mintlify.com".into())
        );
    }

    #[test]
    fn test_extract_hostname_strips_www() {
        assert_eq!(
            extract_hostname("https://www.example.com"),
            Some("example.com".into())
        );
    }

    #[test]
    fn test_extract_hostname_preserves_subdomain() {
        assert_eq!(
            extract_hostname("https://docs.lovable.dev"),
            Some("docs.lovable.dev".into())
        );
    }

    #[test]
    fn test_extract_hostname_invalid_url() {
        assert_eq!(extract_hostname("not-a-url"), None);
    }

    #[test]
    fn test_build_index_urls_with_path() {
        let candidates = build_index_urls("https://example.com/docs");
        assert_eq!(candidates.len(), 2);
        assert_eq!(
            candidates[0].index_url,
            "https://example.com/docs/.well-known/skills/index.json"
        );
        assert_eq!(
            candidates[0].base_url,
            "https://example.com/docs/.well-known/skills"
        );
        assert_eq!(
            candidates[1].index_url,
            "https://example.com/.well-known/skills/index.json"
        );
        assert_eq!(
            candidates[1].base_url,
            "https://example.com/.well-known/skills"
        );
    }

    #[test]
    fn test_build_index_urls_root() {
        let candidates = build_index_urls("https://example.com");
        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0].index_url,
            "https://example.com/.well-known/skills/index.json"
        );
    }
}

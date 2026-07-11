CREATE TABLE npm_packages (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  integrity TEXT NOT NULL,
  shasum TEXT NOT NULL,
  object_key TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (name, version)
) STRICT;

CREATE TABLE cargo_packages (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  object_key TEXT NOT NULL,
  published_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (name, version)
) STRICT;

CREATE TABLE github_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  target_commitish TEXT NOT NULL,
  name TEXT NOT NULL,
  draft INTEGER NOT NULL,
  prerelease INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (repository, tag_name)
) STRICT;

CREATE TABLE github_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (release_id, name),
  FOREIGN KEY (release_id) REFERENCES github_releases(id)
) STRICT;

CREATE TABLE github_tags (
  repository TEXT NOT NULL,
  tag TEXT NOT NULL,
  tag_object_sha TEXT NOT NULL,
  target_sha TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repository, tag)
) STRICT;

CREATE TABLE attestations (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  release_commit TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  artifact_name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX github_assets_release_id ON github_assets(release_id);
CREATE INDEX attestations_repository ON attestations(repository, release_commit);

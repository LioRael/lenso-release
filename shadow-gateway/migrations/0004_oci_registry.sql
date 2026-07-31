CREATE TABLE oci_manifests (
  repository TEXT NOT NULL,
  reference TEXT NOT NULL,
  digest TEXT NOT NULL,
  media_type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (repository, reference)
) STRICT;

CREATE INDEX oci_manifests_digest ON oci_manifests(repository, digest);

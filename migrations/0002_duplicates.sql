-- Optional feature: flag a new ticket that duplicates an open ticket from the same
-- customer. Vectors live in a side table so the hot tickets row stays narrow.

CREATE TABLE ticket_embeddings (
  ticket_id  uuid PRIMARY KEY REFERENCES tickets (id) ON DELETE CASCADE,
  model      text NOT NULL,
  dimensions integer NOT NULL,
  -- real[] rather than pgvector: it needs no extension, which keeps `docker compose up`
  -- working on a stock postgres image. Similarity is computed in the application over a
  -- small candidate set (same customer, open tickets only). See README for the pgvector
  -- migration path once candidate sets stop being small.
  vector     real[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ticket_duplicates (
  ticket_id           uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  duplicate_of        uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  similarity          real NOT NULL CHECK (similarity >= 0 AND similarity <= 1),
  detection_method    text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, duplicate_of),
  CHECK (ticket_id <> duplicate_of)
);

CREATE INDEX ticket_duplicates_of_idx ON ticket_duplicates (duplicate_of);

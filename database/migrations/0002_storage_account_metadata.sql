ALTER TABLE storage_accounts
  ADD COLUMN capabilities TEXT NOT NULL
    DEFAULT '{"presignedUpload":false,"presignedDownload":false,"headObject":false,"deleteObject":false,"bucketProbe":false,"usageProbe":false}'
    CHECK (json_valid(capabilities));

ALTER TABLE storage_accounts
  ADD COLUMN capacity_accuracy TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (capacity_accuracy IN ('EXACT', 'ESTIMATED', 'CONFIGURED', 'UNKNOWN'));

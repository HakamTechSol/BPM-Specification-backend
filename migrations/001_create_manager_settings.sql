-- Migration: Create manager_settings table
-- Description: Stores campsite manager configuration settings
-- Created: 2026-07-12

CREATE TABLE IF NOT EXISTS manager_settings (
  id INT PRIMARY KEY,
  email VARCHAR(255) NULL,
  bank_account VARCHAR(50) NULL,
  payment_id VARCHAR(100) NULL,
  session_duration_days DECIMAL(5,2) NOT NULL DEFAULT 30.0,
  default_max_amperage TINYINT NOT NULL DEFAULT 16,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default settings row
INSERT INTO manager_settings (id, email, bank_account, payment_id, session_duration_days, default_max_amperage)
VALUES (1, NULL, NULL, NULL, 30.0, 16)
ON DUPLICATE KEY UPDATE id = id;

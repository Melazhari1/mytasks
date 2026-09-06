-- =============================================================================
--  MyTasks API — MySQL schema
--  Import:  mysql -u root -p < schema.sql
--  or in phpMyAdmin: Import > choose this file.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS `mytasks`
    DEFAULT CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE `mytasks`;

-- -----------------------------------------------------------------------------
--  Users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
    `id`                     INT AUTO_INCREMENT PRIMARY KEY,
    `name`                   VARCHAR(120)  NULL,
    `email`                  VARCHAR(255)  NOT NULL,
    `password_hash`          VARCHAR(255)  NOT NULL,

    -- TOTP shared secret, itself encrypted at rest (AES-256-CBC) before storing.
    `two_factor_secret`      VARCHAR(255)  NULL,
    `two_factor_method`      ENUM('totp','email') NOT NULL DEFAULT 'email',
    `two_factor_enabled`     TINYINT(1)    NOT NULL DEFAULT 0,
    `two_factor_confirmed_at` TIMESTAMP    NULL DEFAULT NULL,

    -- Optional second gate in front of the vault. Hashed, never stored raw.
    `master_password_hash`   VARCHAR(255)  NULL,

    `failed_login_attempts`  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `locked_until`           DATETIME      NULL DEFAULT NULL,
    `last_login_at`          DATETIME      NULL DEFAULT NULL,

    `created_at`             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY `uq_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
--  Categories (Goals)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `categories` (
    `id`         INT AUTO_INCREMENT PRIMARY KEY,
    `user_id`    INT          NOT NULL,
    `name`       VARCHAR(100) NOT NULL,
    `icon`       VARCHAR(50)  NULL,
    `color`      VARCHAR(20)  NULL,
    `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT `fk_categories_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,

    UNIQUE KEY `uq_categories_user_name` (`user_id`, `name`),
    KEY `idx_categories_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
--  Tasks
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tasks` (
    `id`                    INT AUTO_INCREMENT PRIMARY KEY,
    `user_id`               INT          NOT NULL,
    `category_id`           INT          NOT NULL,
    `title`                 VARCHAR(255) NOT NULL,
    `description`           TEXT         NULL,
    `priority`              ENUM('low','medium','high') NOT NULL DEFAULT 'low',

    `is_recurring`          TINYINT(1)   NOT NULL DEFAULT 0,
    `recurring_type`        ENUM('daily','weekly') NULL DEFAULT NULL,

    `due_date`              DATETIME     NULL DEFAULT NULL,
    `notify_before_minutes` INT          NULL DEFAULT NULL,
    `notified_at`           DATETIME     NULL DEFAULT NULL,

    `status`                ENUM('pending','completed') NOT NULL DEFAULT 'pending',
    `completed_at`          DATETIME     NULL DEFAULT NULL,

    `created_at`            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT `fk_tasks_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_tasks_category`
        FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`) ON DELETE CASCADE,

    KEY `idx_tasks_user_status`  (`user_id`, `status`),
    KEY `idx_tasks_user_due`     (`user_id`, `due_date`),
    KEY `idx_tasks_category`     (`category_id`),
    KEY `idx_tasks_reminders`    (`status`, `due_date`, `notified_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
--  Password Vault
--  `encrypted_password` holds base64(iv || hmac || ciphertext) — AES-256-CBC
--  with an HMAC-SHA256 authentication tag. Never plain text.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `vault_accounts` (
    `id`                 INT AUTO_INCREMENT PRIMARY KEY,
    `user_id`            INT          NOT NULL,
    `platform_name`      VARCHAR(150) NOT NULL,
    `platform_url`       VARCHAR(255) NULL,
    `username`           VARCHAR(150) NOT NULL,
    `encrypted_password` TEXT         NOT NULL,
    `notes`              TEXT         NULL,
    `last_revealed_at`   DATETIME     NULL DEFAULT NULL,
    `created_at`         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT `fk_vault_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,

    KEY `idx_vault_user` (`user_id`),
    KEY `idx_vault_user_platform` (`user_id`, `platform_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
--  Social media ideas — a lightweight idea/link scratchpad, tagged with which
--  platforms it's for. `platforms` is a JSON array of platform keys (see
--  SocialIdeaController::PLATFORMS), e.g. '["youtube","instagram"]'.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `social_ideas` (
    `id`         INT AUTO_INCREMENT PRIMARY KEY,
    `user_id`    INT          NOT NULL,
    `idea`       TEXT         NOT NULL,
    `links`      TEXT         NULL,
    `status`     ENUM('pending','future','done') NOT NULL DEFAULT 'pending',
    `platforms`  VARCHAR(255) NULL,
    `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT `fk_social_ideas_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,

    KEY `idx_social_ideas_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
--  Budget — a monthly salary + expense log, scored against the 50/30/20
--  (need/want/save) rule. One `budget_months` row per user per calendar
--  month; `budget_entries` are the (name, price, category) lines within it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `budget_months` (
    `id`         INT AUTO_INCREMENT PRIMARY KEY,
    `user_id`    INT           NOT NULL,
    `year`       SMALLINT      NOT NULL,
    `month`      TINYINT       NOT NULL,
    `salary`     DECIMAL(12,2) NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT `fk_budget_months_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,

    UNIQUE KEY `uq_budget_months_user_period` (`user_id`, `year`, `month`),
    KEY `idx_budget_months_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `budget_entries` (
    `id`              INT AUTO_INCREMENT PRIMARY KEY,
    `user_id`         INT           NOT NULL,
    `budget_month_id` INT           NOT NULL,
    `name`            VARCHAR(150)  NOT NULL,
    `price`           DECIMAL(12,2) NOT NULL,
    `category`        ENUM('need','want','save') NOT NULL,
    `created_at`      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT `fk_budget_entries_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_budget_entries_month`
        FOREIGN KEY (`budget_month_id`) REFERENCES `budget_months` (`id`) ON DELETE CASCADE,

    KEY `idx_budget_entries_user` (`user_id`),
    KEY `idx_budget_entries_month` (`budget_month_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
--  Supporting tables required by the auth flow
-- =============================================================================

-- Refresh tokens. Only a SHA-256 hash of the token is stored, so a database
-- dump cannot be replayed against the API.
CREATE TABLE IF NOT EXISTS `refresh_tokens` (
    `id`          BIGINT AUTO_INCREMENT PRIMARY KEY,
    `user_id`     INT          NOT NULL,
    `token_hash`  CHAR(64)     NOT NULL,
    `device_name` VARCHAR(120) NULL,
    `user_agent`  VARCHAR(255) NULL,
    `ip_address`  VARCHAR(45)  NULL,
    `expires_at`  DATETIME     NOT NULL,
    `revoked_at`  DATETIME     NULL DEFAULT NULL,
    `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT `fk_refresh_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,

    UNIQUE KEY `uq_refresh_hash` (`token_hash`),
    KEY `idx_refresh_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One-time codes for email-based 2FA. `code_hash` is a SHA-256 hash.
CREATE TABLE IF NOT EXISTS `otp_codes` (
    `id`         BIGINT AUTO_INCREMENT PRIMARY KEY,
    `user_id`    INT       NOT NULL,
    `code_hash`  CHAR(64)  NOT NULL,
    `purpose`    ENUM('login','vault_unlock','device_enroll') NOT NULL DEFAULT 'login',
    `attempts`   TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `expires_at` DATETIME  NOT NULL,
    `used_at`    DATETIME  NULL DEFAULT NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT `fk_otp_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,

    KEY `idx_otp_user_purpose` (`user_id`, `purpose`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mobile biometric enrolment. The device holds the private key in its secure
-- enclave / keystore; the server keeps only the public half (or a hashed
-- shared secret in HMAC mode) and a monotonic counter to stop replay.
CREATE TABLE IF NOT EXISTS `device_tokens` (
    `id`             BIGINT AUTO_INCREMENT PRIMARY KEY,
    `user_id`        INT          NOT NULL,
    `device_id`      VARCHAR(128) NOT NULL,
    `device_name`    VARCHAR(120) NULL,
    `platform`       ENUM('ios','android','other') NOT NULL DEFAULT 'other',
    `public_key`     TEXT         NULL,
    `secret_hash`    CHAR(64)     NULL,
    `last_counter`   BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `last_used_at`   DATETIME     NULL DEFAULT NULL,
    `revoked_at`     DATETIME     NULL DEFAULT NULL,
    `created_at`     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT `fk_device_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,

    UNIQUE KEY `uq_device_user_device` (`user_id`, `device_id`),
    KEY `idx_device_lookup` (`device_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Generic throttle bucket: login attempts, OTP verification, vault reveals.
CREATE TABLE IF NOT EXISTS `rate_limits` (
    `id`           BIGINT AUTO_INCREMENT PRIMARY KEY,
    `bucket_key`   VARCHAR(190) NOT NULL,
    `hits`         INT UNSIGNED NOT NULL DEFAULT 0,
    `window_start` DATETIME     NOT NULL,

    UNIQUE KEY `uq_rate_bucket` (`bucket_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only trail of security-relevant events.
CREATE TABLE IF NOT EXISTS `audit_logs` (
    `id`          BIGINT AUTO_INCREMENT PRIMARY KEY,
    `user_id`     INT          NULL,
    `action`      VARCHAR(60)  NOT NULL,
    `subject`     VARCHAR(120) NULL,
    `ip_address`  VARCHAR(45)  NULL,
    `user_agent`  VARCHAR(255) NULL,
    `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT `fk_audit_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,

    KEY `idx_audit_user_action` (`user_id`, `action`),
    KEY `idx_audit_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

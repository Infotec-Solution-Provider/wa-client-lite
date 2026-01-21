/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8 */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

CREATE TABLE IF NOT EXISTS `automatic_messages` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `instance_number` varchar(13) COLLATE utf8_unicode_ci NOT NULL,
  `text` text COLLATE utf8_unicode_ci,
  `attachment` varchar(255) COLLATE utf8_unicode_ci DEFAULT NULL,
  `attachment_type` enum('contact','document','image','video','audio','voice','location') COLLATE utf8_unicode_ci DEFAULT NULL,
  `send_condition` text COLLATE utf8_unicode_ci NOT NULL,
  `send_max_times` int(11) NOT NULL DEFAULT '1',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `FK_AUTO_MESSAGE_INSTANCE_NUMBER` (`instance_number`),
  CONSTRAINT `FK_AUTO_MESSAGE_INSTANCE_NUMBER` FOREIGN KEY (`instance_number`) REFERENCES `whatsapp_instances` (`number`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS `blocked_numbers` (
  `instance_number` varchar(13) COLLATE utf8_unicode_ci NOT NULL DEFAULT '',
  `blocked_number` varchar(13) COLLATE utf8_unicode_ci NOT NULL DEFAULT '',
  `blocked_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `IDX_UNIQUE_INSTANCE_BLOCKED_NUMBER` (`instance_number`,`blocked_number`),
  CONSTRAINT `FK_BLOCKED_INSTANCE_NUMBER` FOREIGN KEY (`instance_number`) REFERENCES `whatsapp_instances` (`number`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS `clients` (
  `name` varchar(50) COLLATE utf8_unicode_ci NOT NULL DEFAULT '',
  `display_name` varchar(50) COLLATE utf8_unicode_ci DEFAULT NULL,
  `is_active` tinyint(4) NOT NULL DEFAULT '0',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `inactivated_at` timestamp NULL DEFAULT NULL,
  UNIQUE KEY `PK_CUSTMER_NAME` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS `database_connections` (
  `client_name` varchar(50) COLLATE utf8_unicode_ci NOT NULL,
  `host` varchar(12) COLLATE utf8_unicode_ci NOT NULL DEFAULT '',
  `port` int(11) NOT NULL DEFAULT '3306',
  `user` text COLLATE utf8_unicode_ci NOT NULL,
  `password` text COLLATE utf8_unicode_ci NOT NULL,
  `database` varchar(50) COLLATE utf8_unicode_ci NOT NULL DEFAULT '',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`client_name`),
  UNIQUE KEY `IDX_UNIQUE_DATABASE` (`host`,`database`,`port`),
  CONSTRAINT `FK_CONNECTION_CLIENT_NAME` FOREIGN KEY (`client_name`) REFERENCES `clients` (`name`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS `whatsapp_instances` (
  `number` varchar(13) COLLATE utf8_unicode_ci NOT NULL,
  `client_name` varchar(50) COLLATE utf8_unicode_ci NOT NULL,
  `type` enum('WWEBJS','BAILEYS') COLLATE utf8_unicode_ci NOT NULL DEFAULT 'WWEBJS',
  `is_active` tinyint(4) NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `inactivated_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`number`),
  KEY `FK_INSTANCE_CLIENT` (`client_name`),
  CONSTRAINT `FK_INSTANCE_CLIENT` FOREIGN KEY (`client_name`) REFERENCES `clients` (`name`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

-- Tabela para armazenar mensagens localmente para sincronização
CREATE TABLE IF NOT EXISTS `messages` (
  `ID` varchar(100) COLLATE utf8_unicode_ci NOT NULL,
  `MENSAGEM` text COLLATE utf8_unicode_ci,
  `ID_REFERENCIA` varchar(100) COLLATE utf8_unicode_ci DEFAULT NULL,
  `TIPO` varchar(50) COLLATE utf8_unicode_ci DEFAULT NULL,
  `TIMESTAMP` bigint(20) DEFAULT NULL,
  `FROM_ME` tinyint(1) NOT NULL DEFAULT '0',
  `DATA_HORA` datetime DEFAULT NULL,
  `STATUS` varchar(20) COLLATE utf8_unicode_ci DEFAULT NULL,
  `ARQUIVO_TIPO` varchar(100) COLLATE utf8_unicode_ci DEFAULT NULL,
  `ARQUIVO_NOME_ORIGINAL` varchar(255) COLLATE utf8_unicode_ci DEFAULT NULL,
  `ARQUIVO_NOME` varchar(255) COLLATE utf8_unicode_ci DEFAULT NULL,
  `ARQUIVO_ARMAZENAMENTO` varchar(50) COLLATE utf8_unicode_ci DEFAULT NULL,
  `SYNC_MESSAGE` tinyint(1) NOT NULL DEFAULT '0',
  `SYNC_STATUS` tinyint(1) NOT NULL DEFAULT '0',
  `INSTANCE` varchar(100) COLLATE utf8_unicode_ci NOT NULL,
  `FROM` varchar(20) COLLATE utf8_unicode_ci NOT NULL,
  PRIMARY KEY (`ID`),
  KEY `idx_instance` (`INSTANCE`),
  KEY `idx_sync` (`SYNC_MESSAGE`,`SYNC_STATUS`),
  KEY `idx_from` (`FROM`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

CREATE TABLE IF NOT EXISTS `raw_messages` (
  `ID` varchar(100) COLLATE utf8_unicode_ci NOT NULL,
  `SOURCE` ENUM('WWEBJS','BAILEYS') COLLATE utf8_unicode_ci NOT NULL,
  `RAW_DATA` longtext COLLATE utf8_unicode_ci,
  `CREATED_AT` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

/*!40103 SET TIME_ZONE=IFNULL(@OLD_TIME_ZONE, 'system') */;
/*!40101 SET SQL_MODE=IFNULL(@OLD_SQL_MODE, '') */;
/*!40014 SET FOREIGN_KEY_CHECKS=IFNULL(@OLD_FOREIGN_KEY_CHECKS, 1) */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40111 SET SQL_NOTES=IFNULL(@OLD_SQL_NOTES, 1) */;

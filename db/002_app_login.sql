-- Creates the low-privilege account the API connects with.
-- Run this in SSMS with the `commanderparty` database selected (not master).
--
-- It is a contained database user, so no server-level login is needed and it
-- cannot reach any other database on the server. Replace the password below
-- before running, then put the same password in the SWA app setting
-- SQL_CONNECTION_STRING. Never commit the real password.

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'commander_api')
    CREATE USER commander_api WITH PASSWORD = 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';

-- Table access only. No DDL, no other schemas, no server roles.
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.Parties      TO commander_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.Players      TO commander_api;
GRANT SELECT, INSERT, DELETE         ON dbo.JoinAttempts TO commander_api;

PRINT 'commander_api user is ready.';

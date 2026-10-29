-- Commander Party schema. Run against the `commanderparty` database in SSMS.
-- Safe to re-run: every object is created only if it does not already exist.

SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID('dbo.Parties', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Parties (
        Id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_Parties PRIMARY KEY DEFAULT NEWID(), -- the GUID in the share link
        HostUserId  NVARCHAR(128)    NOT NULL,  -- userId from the Static Web Apps client principal
        Name        NVARCHAR(80)     NOT NULL,
        StateJson   NVARCHAR(MAX)    NOT NULL,  -- host-only snapshot: event, tables, rounds, results, currentRound
        CreatedAt   DATETIME2(0)     NOT NULL CONSTRAINT DF_Parties_CreatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedAt   DATETIME2(0)     NOT NULL CONSTRAINT DF_Parties_UpdatedAt DEFAULT SYSUTCDATETIME(),
        ExpiresAt   DATETIME2(0)     NOT NULL,  -- CreatedAt + 60 days; the API serves 410 after this
        JoinCount   INT              NOT NULL CONSTRAINT DF_Parties_JoinCount DEFAULT 0,
        CONSTRAINT CK_Parties_Name      CHECK (LEN(Name) BETWEEN 1 AND 80),
        CONSTRAINT CK_Parties_StateJson CHECK (ISJSON(StateJson) = 1 AND DATALENGTH(StateJson) <= 131072), -- 64 KB of NVARCHAR
        CONSTRAINT CK_Parties_Expires   CHECK (ExpiresAt > CreatedAt)
    );
END;

IF OBJECT_ID('dbo.Players', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Players (
        Id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_Players PRIMARY KEY DEFAULT NEWID(),
        PartyId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_Players_Party REFERENCES dbo.Parties(Id) ON DELETE CASCADE,
        Name        NVARCHAR(40)     NOT NULL,
        Experience  VARCHAR(10)      NOT NULL,
        Dish        NVARCHAR(80)     NOT NULL CONSTRAINT DF_Players_Dish DEFAULT '',
        PartnerId   UNIQUEIDENTIFIER NULL,     -- locked pair; the API keeps it symmetric
        EditToken   UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Players_EditToken DEFAULT NEWID(), -- a guest may edit only the row whose token they hold
        AddedByHost BIT              NOT NULL CONSTRAINT DF_Players_AddedByHost DEFAULT 0,
        CreatedAt   DATETIME2(0)     NOT NULL CONSTRAINT DF_Players_CreatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedAt   DATETIME2(0)     NOT NULL CONSTRAINT DF_Players_UpdatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_Players_Name       CHECK (LEN(Name) BETWEEN 1 AND 40),
        CONSTRAINT CK_Players_Experience CHECK (Experience IN ('New', 'Learning', 'Veteran')),
        CONSTRAINT CK_Players_Partner    CHECK (PartnerId IS NULL OR PartnerId <> Id)
    );
END;

IF OBJECT_ID('dbo.JoinAttempts', 'U') IS NULL
BEGIN
    -- Rate limiting that survives function restarts. Rows older than an hour are pruned by the API.
    CREATE TABLE dbo.JoinAttempts (
        PartyId     UNIQUEIDENTIFIER NOT NULL,
        IpHash      CHAR(64)         NOT NULL,  -- SHA-256 hex of the client IP; raw IPs are never stored
        AttemptedAt DATETIME2(0)     NOT NULL CONSTRAINT DF_JoinAttempts_AttemptedAt DEFAULT SYSUTCDATETIME()
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Players_Party' AND object_id = OBJECT_ID('dbo.Players'))
    CREATE INDEX IX_Players_Party ON dbo.Players (PartyId);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Parties_Host' AND object_id = OBJECT_ID('dbo.Parties'))
    CREATE INDEX IX_Parties_Host ON dbo.Parties (HostUserId, CreatedAt DESC);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Parties_Expires' AND object_id = OBJECT_ID('dbo.Parties'))
    CREATE INDEX IX_Parties_Expires ON dbo.Parties (ExpiresAt);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_JoinAttempts_Lookup' AND object_id = OBJECT_ID('dbo.JoinAttempts'))
    CREATE INDEX IX_JoinAttempts_Lookup ON dbo.JoinAttempts (PartyId, IpHash, AttemptedAt);

COMMIT TRANSACTION;

PRINT 'Commander Party schema is in place.';

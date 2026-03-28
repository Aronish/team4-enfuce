interface ViteTypeOptions {
  // By adding this line, you can make the type of ImportMetaEnv strict
  // to disallow unknown keys.
  // strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
  readonly VITE_SNOWFLAKE_PAT: string
  readonly VITE_SNOWFLAKE_ACCOUNT: string
  readonly VITE_SNOWFLAKE_DATABASE: string
  readonly VITE_SNOWFLAKE_SCHEMA: string
  readonly VITE_SNOWFLAKE_AGENT: string
  // more env variables...
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
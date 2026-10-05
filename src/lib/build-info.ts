export interface BuildIdentity {
  schemaVersion: 1;
  repository: string;
  commit: string;
  source: "github-actions" | "local";
  dirty: boolean;
  buildId: string | null;
  runUrl: string | null;
  releaseUrl: string | null;
}

export interface BuildInfo extends BuildIdentity {
  files: Record<string, string>;
}

declare const __BUILD_IDENTITY__: BuildIdentity;

export const buildIdentity = __BUILD_IDENTITY__;

export type Sha256 = `sha256:${string}`;
export type GitOid = string;
export type RegistryPackageId = `cargo:${string}` | `npm:${string}` | `artifact:${string}`;

export type PackageDependency = {
  id: string;
  requirement: string;
  resolvedVersion: string;
  source: "registry" | "plan";
};

export type Bump = "patch" | "minor" | "major";

export type ReleasePackage = {
  id: string;
  previousVersion: string;
  nextVersion: string;
  bump: Bump;
  releaseGroup: string;
  userFacing: boolean;
  dependencies: PackageDependency[];
};

export type PublisherContract = {
  workflow: string;
  workflowSha256: Sha256;
  sharedRevision: GitOid;
  sharedBundleSha256: Sha256;
  runner: string;
  node: string;
  npm: string;
  rust: string;
};

export type ReleasePlanV1 = {
  schema: "lenso.release-plan.v1";
  planId: Sha256;
  repository: string;
  sourceCommit: GitOid;
  tegamiVersion: "1.2.5";
  publisher: PublisherContract;
  generatedFiles: { path: string; sha256: Sha256 }[];
  packages: ReleasePackage[];
};

export type EventPackage = { id: string; version: string };

type ReleaseEventBase = {
  schema: "lenso.release-event.v1";
  eventId: Sha256;
  issuedAt: string;
  nonce: string;
  sourceRepository: string;
  expectedAppId: number;
  planId: Sha256;
  planUrl: string;
  planSha256: Sha256;
  releaseCommit: GitOid;
};

export type ReleaseEventV1 =
  | (ReleaseEventBase & { eventType: "lenso-plan-ready" })
  | (ReleaseEventBase & {
      eventType: "lenso-publish-requested";
      packages: EventPackage[];
    })
  | (ReleaseEventBase & {
      eventType: "lenso-publish-receipt";
      correlationId: Sha256;
      receipt: ComponentReceiptV1;
    });

export type ComponentReceiptV1 = {
  schema: "lenso.component-receipt.v1";
  receiptId: Sha256;
  planId: Sha256;
  packageId: RegistryPackageId;
  version: string;
  repository: string;
  sourceCommit: GitOid;
  packedSha256: Sha256;
  registryIntegrity: string;
  registryUrl: string;
  provenanceUrl: string;
  provenanceSubject: { name: string; digest: string };
  workflowUrl: string;
  tagUrl: string;
  publishedAt: string;
};

export type PlanStateStatus = "ready" | "publishing" | "blocked" | "verified";
export type PlanStateAttempt = {
  eventId: Sha256;
  kind: "ready" | "dispatch" | "receipt" | "recovery" | "cancel";
  at: string;
  outcome: "accepted" | "duplicate" | "conflict" | "blocked";
  detail: string | null;
};
export type PlanStatePackage = {
  id: RegistryPackageId;
  version: string;
  phase: number;
  status: "pending" | "dispatched" | "received";
  requestEventId: Sha256 | null;
};
export type PlanStateEvidence = { kind: string; url: string | null; digest: string | null };
export type PlanDispatchOutbox = {
  eventId: Sha256;
  nonce: string;
  ref: string;
  workflow: string;
  packages: EventPackage[];
  inputs: Record<"event_id" | "plan_id" | "plan_sha256" | "release_commit" | "packages_json" | "nonce", string>;
  status: "pending" | "in-flight" | "dispatched" | "cancelled";
  claimOwner: string | null;
  leaseExpiresAt: string | null;
  runUrl: string | null;
  createdAt: string;
  updatedAt: string;
};
export type PlanStateV1 = {
  schema: "lenso.plan-state.v1";
  repository: string;
  planId: Sha256;
  planSha256: Sha256;
  sourceCommit: GitOid;
  releaseCommit: GitOid;
  status: PlanStateStatus;
  reason: string | null;
  evidence: PlanStateEvidence[];
  packages: PlanStatePackage[];
  receipts: ComponentReceiptV1[];
  attempts: PlanStateAttempt[];
  outbox: PlanDispatchOutbox[];
  occupancyKeys: string[];
  executionRef: { name: string; tip: GitOid; protected: true };
  revision: number;
  previousBlobSha: GitOid | null;
  createdAt: string;
  updatedAt: string;
};

export type RepositoryRevision = {
  repository: string;
  releaseCommit: GitOid;
};

export type SystemPackage = {
  id: RegistryPackageId;
  version: string;
  tagUrl: string;
  registryUrl: string;
  registryIntegrity: string;
};

export type SystemArtifact = {
  id: string;
  url: string;
  sha256: Sha256;
  provenanceUrl: string;
};

export type CatalogReference = { url: string; sha256: Sha256 };
export type ToolchainRequirements = {
  minimumNode: string;
  minimumRust: string;
};

export type ComponentReceiptSummary = {
  receiptId: Sha256;
  packageId: string;
  version: string;
  sourceCommit: GitOid;
  packedSha256: Sha256;
  tagUrl: string;
};

export type SystemComponents = {
  createdAt: string;
  repositories: RepositoryRevision[];
  packages: SystemPackage[];
  artifacts: SystemArtifact[];
  catalog: CatalogReference;
  requirements: ToolchainRequirements;
  receipts: ComponentReceiptSummary[];
  systemSmokeRunUrls: string[];
};

export type SystemReleaseV1 = SystemComponents & {
  schema: "lenso.system-release.v1";
  systemVersion: string;
};

export type CandidateValidation = {
  status: "pending" | "passed" | "failed";
  systemSmokeRunUrls: string[];
};

export type SystemCandidateV1 = SystemComponents & {
  schema: "lenso.system-candidate.v1";
  candidateId: Sha256;
  systemVersion: string;
  proposedSystemVersion: string;
  bumpReason: string;
  validation: CandidateValidation;
};

export type SystemChannelV1 =
  | {
      schema: "lenso.system-channel.v1";
      channel: "stable";
      systemVersion: string;
      manifestUrl: string;
      manifestSha256: Sha256;
      updatedAt: string;
    }
  | {
      schema: "lenso.system-channel.v1";
      channel: "next";
      systemVersion: string;
      candidateId: Sha256;
      manifestUrl: string;
      manifestSha256: Sha256;
      updatedAt: string;
    };

type FrameworkLockBase = {
  schema: "lenso.framework-lock.v1";
  systemVersion: string;
  manifestSha256: Sha256;
  resolvedAt: string;
};

export type FrameworkLockV1 =
  | (FrameworkLockBase & { channel: "stable"; manifest: SystemReleaseV1 })
  | (FrameworkLockBase & { channel: "next"; manifest: SystemCandidateV1 });

export type ReconciliationStatus = "aligned" | "drift" | "blocked" | "observation-failure";
export type ReconciliationIssue = {
  code: string;
  severity: Exclude<ReconciliationStatus, "aligned">;
  componentId: string;
  detail: string;
};
export type ReconciliationObservation = {
  state: "present" | "missing" | "failure" | "not-applicable";
  version: string | null;
  digest: string | null;
  publishedAt: string | null;
  canonicalUrl: string | null;
  failure: string | null;
};
export type ReconciliationComponent = {
  id: string;
  source: ReconciliationObservation;
  registry: ReconciliationObservation;
  tag: ReconciliationObservation;
  embeddedCatalog: ReconciliationObservation;
  workerCatalog: ReconciliationObservation;
};
export type ReconciliationReportV1 = {
  schema: "lenso.reconciliation-report.v1";
  status: ReconciliationStatus;
  observedAt: string;
  components: ReconciliationComponent[];
  issues: ReconciliationIssue[];
};

import type { EventPackage, ReleaseEventV1 } from "./types.js";

export type PublishRequestV1 = Extract<ReleaseEventV1, { eventType: "lenso-publish-requested" }>;

/** GitHub facts re-read by the caller. Never populate this object from the event body. */
export type ObservedPublishRequest = {
  actor: string;
  appId: number;
  repository: string;
  sourceRepository: string;
  sourceCommit: string;
  releaseCommit: string;
  sourceCommitRepository: string;
  releaseCommitRepository: string;
  releaseCommitContainsSourceCommit: boolean;
  planSha256: string;
  ref: string;
  workflowPath: string;
};

export type VerifiedPublishRequest = {
  event: PublishRequestV1;
  observed: ObservedPublishRequest;
  packages: readonly EventPackage[];
};

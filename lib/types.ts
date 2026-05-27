export type WorkspaceKey = "holder" | "verifier";
export type ProductLocale = "pt" | "en";

export type ZcashNetwork = "mainnet" | "testnet";

export interface CredentialWitness {
  holderCommitmentLabel: string;
  redactionMode: string;
  disclosureScope: string[];
  issuedAt: string;
  expiresAt: string;
}

export interface CredentialProofArtifact {
  system: "Halo2";
  verification: "IPA";
  circuitFamily: string;
  payloadLabel: string;
  proofSize: string;
  disclosedAttributes: string[];
}

export interface AnchorRecord {
  network: ZcashNetwork;
  pool: "Orchard" | "Sapling";
  anchorHeight: string;
  anchorTxLabel: string;
  trailLabel: string;
}

export interface HolderPassport {
  id: string;
  displayName: string;
  residenceLabel: string;
  assuranceLevel: string;
  witness: CredentialWitness;
  anchor: AnchorRecord;
}

export interface VerifierBundle {
  id: string;
  displayName: string;
  reviewFocus: string;
  jurisdiction: string;
  acceptedNetworks: ZcashNetwork[];
  acceptedCredentialTypes: string[];
}

export interface VerificationDecision {
  status: "approved" | "review" | "rejected";
  summary: string;
  rationale: string;
  verifiedAt: string;
  verifierId: string;
}

export interface ProductPolicyContext {
  title: string;
  summary: string;
  networkLabel: string;
  network: ZcashNetwork;
  jurisdiction: string;
  assuranceLine: string;
  witness: CredentialWitness;
  artifact: CredentialProofArtifact;
  anchor: AnchorRecord;
  verifier: VerifierBundle;
}

export interface OnboardingStep {
  id: "review" | "compose" | "share" | "validate" | "decide";
  title: string;
  body: string;
  highlight: string;
}

export interface LocalVerifierProfile {
  id: string;
  displayName: string;
  focusLabel: string;
  regionLabel: string;
}

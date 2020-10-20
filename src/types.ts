import {
  Deployment,
  FixtureFunc,
  DeploymentSubmission,
  Artifact
} from "hardhat/types";

export type ExtendedArtifact = Artifact & {
  metadata?: string;
};

export interface PartialExtension {
  save(name: string, deployment: DeploymentSubmission): Promise<void>;
  get(name: string): Promise<Deployment>;
  getOrNull(name: string): Promise<Deployment | null>;
  getDeploymentsFromAddress(address: string): Promise<Deployment[]>;
  all(): Promise<{ [name: string]: Deployment }>;
  getArtifact(name: string): Promise<ExtendedArtifact>;
  run(
    tags?: string | string[],
    options?: {
      resetMemory?: boolean;
      deletePreviousDeployments?: boolean;
      writeDeploymentsToFiles?: boolean;
      export?: string;
      exportAll?: string;
    }
  ): Promise<{ [name: string]: Deployment }>;
  fixture(tags?: string | string[]): Promise<{ [name: string]: Deployment }>;
  createFixture(func: FixtureFunc, id?: string): () => Promise<any>; // TODO Type Parameter
  log(...args: any[]): void;
}

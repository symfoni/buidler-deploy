import "./type-extensions";
import path from "path";
import {
  HardhatRuntimeEnvironment,
  Deployment,
  HardhatConfig,
  HardhatUserConfig
} from "hardhat/types";
import {
  extendEnvironment,
  task,
  internalTask,
  extendConfig
} from "hardhat/config";
import { HardhatError } from "hardhat/internal/core/errors";
import {
  JsonRpcServer,
  JsonRpcServerConfig
} from "hardhat/internal/hardhat-network/jsonrpc/server";
import { HARDHAT_NETWORK_NAME } from "hardhat/internal/constants";
import * as types from "hardhat/internal/core/params/argumentTypes";
import { ERRORS } from "hardhat/internal/core/errors-list";
import chalk from "chalk";
import {
  TASK_NODE,
  TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT,
  TASK_TEST
} from "hardhat/builtin-tasks/task-names";

import debug from "debug";
const log = debug("hardhat:wighawag:hardhat-deploy");

import { DeploymentsManager } from "./DeploymentsManager";
import chokidar from "chokidar";
import { submitSources } from "./etherscan";

function isHardhatEVM(hre: HardhatRuntimeEnvironment): boolean {
  const { network, hardhatArguments, config } = hre;
  return !(
    network.name !== HARDHAT_NETWORK_NAME &&
    // We normally set the default network as hardhatArguments.network,
    // so this check isn't enough, and we add the next one. This has the
    // effect of `--network <defaultNetwork>` being a false negative, but
    // not a big deal.
    hardhatArguments.network !== undefined &&
    hardhatArguments.network !== config.defaultNetwork
  );
}

function normalizePath(
  config: HardhatConfig,
  userPath: string | undefined,
  defaultPath: string
): string {
  if (userPath === undefined) {
    userPath = path.join(config.paths.root, defaultPath);
  } else {
    if (!path.isAbsolute(userPath)) {
      userPath = path.normalize(path.join(config.paths.root, userPath));
    }
  }
  return userPath;
}

extendConfig(
  (config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
    config.paths.deployments = normalizePath(
      config,
      userConfig.paths?.deployments,
      "deployments"
    );

    config.paths.imports = normalizePath(
      config,
      userConfig.paths?.imports,
      "imports"
    );

    config.paths.deploy = normalizePath(
      config,
      userConfig.paths?.deploy,
      "deploy"
    );
  }
);

log("start...");
let deploymentsManager: DeploymentsManager;
extendEnvironment(env => {
  let live = true;
  if (env.network.name === "localhost" || env.network.name === "hardhat") {
    // the 2 default network are not live network
    live = false;
  }
  if (env.network.config.live !== undefined) {
    live = env.network.config.live;
  }
  env.network.live = live;

  // associate tags to current network as object
  env.network.tags = {};
  const tags = env.network.config.tags || [];
  for (const tag of tags) {
    env.network.tags[tag] = true;
  }

  if (env.network.config.saveDeployments === undefined) {
    env.network.saveDeployments = true;
  } else {
    env.network.saveDeployments = env.network.config.saveDeployments;
  }

  if (deploymentsManager === undefined || env.deployments === undefined) {
    deploymentsManager = new DeploymentsManager(env);
    env.deployments = deploymentsManager.deploymentsExtension;
    env.getNamedAccounts = deploymentsManager.getNamedAccounts.bind(
      deploymentsManager
    );
    env.getUnnamedAccounts = deploymentsManager.getUnnamedAccounts.bind(
      deploymentsManager
    );
  }
  log("ready");
});

function addIfNotPresent(array: string[], value: string) {
  if (array.indexOf(value) === -1) {
    array.push(value);
  }
}

function setupExtraSolcSettings(settings: {
  metadata: { useLiteralContent: boolean };
  outputSelection: { "*": { "": string[]; "*": string[] } };
}): void {
  settings.metadata = settings.metadata || {};
  settings.metadata.useLiteralContent = true;

  if (settings.outputSelection === undefined) {
    settings.outputSelection = {
      "*": {
        "*": [],
        "": []
      }
    };
  }
  if (settings.outputSelection["*"] === undefined) {
    settings.outputSelection["*"] = {
      "*": [],
      "": []
    };
  }
  if (settings.outputSelection["*"]["*"] === undefined) {
    settings.outputSelection["*"]["*"] = [];
  }
  if (settings.outputSelection["*"][""] === undefined) {
    settings.outputSelection["*"][""] = [];
  }

  addIfNotPresent(settings.outputSelection["*"]["*"], "abi");
  addIfNotPresent(settings.outputSelection["*"]["*"], "evm.bytecode");
  addIfNotPresent(settings.outputSelection["*"]["*"], "evm.deployedBytecode");
  addIfNotPresent(settings.outputSelection["*"]["*"], "metadata");
  addIfNotPresent(settings.outputSelection["*"]["*"], "devdoc");
  addIfNotPresent(settings.outputSelection["*"]["*"], "userdoc");
  addIfNotPresent(settings.outputSelection["*"]["*"], "storageLayout");
  addIfNotPresent(settings.outputSelection["*"]["*"], "evm.methodIdentifiers");
  addIfNotPresent(settings.outputSelection["*"]["*"], "evm.gasEstimates");
  // addIfNotPresent(settings.outputSelection["*"][""], "ir");
  // addIfNotPresent(settings.outputSelection["*"][""], "irOptimized");
  // addIfNotPresent(settings.outputSelection["*"][""], "ast");
}

internalTask(TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT).setAction(
  async (_, __, runSuper) => {
    const input = await runSuper();
    setupExtraSolcSettings(input.settings);

    return input;
  }
);

internalTask("deploy:run", "deploy ")
  .addOptionalParam("export", "export current network deployments")
  .addOptionalParam("exportAll", "export all deployments into one file")
  .addOptionalParam("tags", "dependencies to run")
  .addOptionalParam(
    "write",
    "whether to write deployments to file",
    true,
    types.boolean
  )
  .addOptionalParam(
    "pendingtx",
    "whether to save pending tx",
    false,
    types.boolean
  )
  .addOptionalParam(
    "gasprice",
    "gas price to use for transactions",
    undefined,
    types.string
  )
  .addFlag("noCompile", "disable pre compilation")
  .addFlag("reset", "whether to delete deployments files first")
  .addFlag("log", "whether to output log")
  .addFlag("watch", "redeploy on every change of contract or deploy script")
  .addFlag(
    "watchOnly",
    "do not actually deploy, just watch and deploy if changes occurs"
  )
  .setAction(async (args, hre) => {
    async function compileAndDeploy() {
      if (!args.noCompile) {
        await hre.run("compile");
      }
      return deploymentsManager.runDeploy(args.tags, {
        log: args.log,
        resetMemory: false,
        deletePreviousDeployments: args.reset,
        writeDeploymentsToFiles: args.write,
        export: args.export,
        exportAll: args.exportAll,
        savePendingTx: args.pendingtx,
        gasPrice: args.gasprice
      });
    }

    let currentPromise: Promise<{
      [name: string]: Deployment;
    }> | null = args.watchOnly ? null : compileAndDeploy();
    if (args.watch || args.watchOnly) {
      const watcher = chokidar.watch(
        [hre.config.paths.sources, hre.config.paths.deploy],
        {
          ignored: /(^|[\/\\])\../, // ignore dotfiles
          persistent: true
        }
      );

      watcher.on("ready", () =>
        console.log("Initial scan complete. Ready for changes")
      );

      let rejectPending: any = null;
      function pending(): Promise<any> {
        return new Promise((resolve, reject) => {
          rejectPending = reject;
          if (currentPromise) {
            currentPromise
              .then(() => {
                rejectPending = null;
                resolve();
              })
              .catch(error => {
                rejectPending = null;
                currentPromise = null;
                console.error(error);
              });
          } else {
            rejectPending = null;
            resolve();
          }
        });
      }
      watcher.on("change", async (path, stats) => {
        console.log("change detected");
        if (currentPromise) {
          console.log("deployment in progress, please wait ...");
          if (rejectPending) {
            // console.log("disabling previously pending redeployments...");
            rejectPending();
          }
          try {
            // console.log("waiting for current redeployment...");
            await pending();
            // console.log("pending finished");
          } catch (e) {
            return;
          }
        }
        currentPromise = compileAndDeploy();
        try {
          await currentPromise;
        } catch (e) {
          console.error(e);
        }
        currentPromise = null;
      });
      try {
        await currentPromise;
      } catch (e) {
        console.error(e);
      }
      currentPromise = null;
      await new Promise(resolve => setTimeout(resolve, 2000000000)); // TODO better way ?
    } else {
      const firstDeployments = await currentPromise;
      return firstDeployments;
    }
  });

task(TASK_TEST, "Runs mocha tests")
  .addFlag("deployFixture", "run the global fixture before tests")
  .setAction(async (args, hre, runSuper) => {
    if (args.deployFixture || process.env.HARDHAT_DEPLOY_FIXTURE) {
      if (!args.noCompile && !process.env.HARDHAT_DEPLOY_NO_COMPILE) {
        await hre.run("compile");
      }
      await hre.deployments.fixture();
      return runSuper({ ...args, noCompile: true });
    } else {
      return runSuper(args);
    }
  });

task("deploy", "Deploy contracts")
  .addOptionalParam("export", "export current network deployments")
  .addOptionalParam("exportAll", "export all deployments into one file")
  .addOptionalParam("tags", "dependencies to run")
  .addOptionalParam(
    "write",
    "whether to write deployments to file",
    undefined,
    types.boolean
  )
  // TODO pendingtx
  .addOptionalParam(
    "gasprice",
    "gas price to use for transactions",
    undefined,
    types.string
  )
  .addFlag("noCompile", "disable pre compilation")
  .addFlag("reset", "whether to delete deployments files first")
  .addFlag("silent", "whether to remove log")
  .addFlag("watch", "redeploy on every change of contract or deploy script")
  .setAction(async (args, hre) => {
    args.log = !args.silent;
    delete args.silent;
    if (args.write === undefined) {
      args.write = !isHardhatEVM(hre);
    }
    args.pendingtx = !isHardhatEVM(hre);
    await hre.run("deploy:run", args);
  });

task(
  "export",
  "export contract deployment of the specified network into one file"
)
  .addOptionalParam("export", "export current network deployments")
  .addOptionalParam("exportAll", "export all deployments into one file")
  .setAction(async (args, hre) => {
    await deploymentsManager.loadDeployments(false);
    await deploymentsManager.export(args);
  });

task(TASK_NODE, "Starts a JSON-RPC server on top of Hardhat EVM")
  .addOptionalParam("export", "export current network deployments")
  .addOptionalParam("exportAll", "export all deployments into one file")
  .addOptionalParam("tags", "dependencies to run")
  .addOptionalParam(
    "write",
    "whether to write deployments to file",
    true,
    types.boolean
  )
  .addOptionalParam(
    "gasprice",
    "gas price to use for transactions",
    undefined,
    types.string
  )
  .addFlag("reset", "whether to delete deployments files first")
  .addFlag("silent", "whether to renove log")
  .addFlag("noDeploy", "do not deploy")
  .addFlag("watch", "redeploy on every change of contract or deploy script")
  .setAction(async (args, hre, runSuper) => {
    if (args.noDeploy) {
      await runSuper(args);
      return;
    }

    if (!isHardhatEVM(hre)) {
      throw new HardhatError(ERRORS.BUILTIN_TASKS.JSONRPC_UNSUPPORTED_NETWORK);
    }

    const { config } = hre;

    hre.network.name = "localhost"; // Ensure deployments can be fetched with console
    // TODO use localhost config ? // Or post an issue on hardhat
    const watch = args.watch;
    args.watch = false;
    args.log = !args.silent;
    delete args.silent;
    args.pendingtx = false;
    await hre.run("deploy:run", args);

    // enable logging
    // TODO fix this when there's a proper mechanism for doing this
    let provider = hre.network.provider as any;
    let i = 0;
    while (provider._loggingEnabled === undefined) {
      if (provider._provider !== undefined) {
        provider = provider._provider;
      } else if (provider._wrappedProvider !== undefined) {
        provider = provider._wrappedProvider;
      } else {
        throw new Error("should not happen");
      }

      // a HardhatEVMProvider should eventually be found, but
      // just in case we add a max number of iterations here
      // to avoid and endless loop
      i++;
      if (i > 100) {
        throw new Error("should not happen");
      }
    }
    provider._loggingEnabled = true;
    provider._ethModule._logger = provider._logger;

    const { hostname, port } = args;
    let server;
    try {
      const serverConfig: JsonRpcServerConfig = {
        hostname,
        port,
        provider: hre.network.provider
      };

      server = new JsonRpcServer(serverConfig);

      const { port: actualPort, address } = await server.listen();

      console.log(
        chalk.green(
          `Started HTTP and WebSocket JSON-RPC server at http://${address}:${actualPort}/`
        )
      );

      console.log();

      let watchRequired;
      try {
        watchRequired = require("hardhat/builtin-tasks/utils/watch");
      } catch (e) {}

      let reporterRequired;
      try {
        reporterRequired = require("hardhat/internal/sentry/reporter");
      } catch (e) {}

      if (watchRequired) {
        try {
          const { watchCompilerOutput } = watchRequired;
          await watchCompilerOutput(server.getProvider(), config.paths);
        } catch (error) {
          console.warn(
            chalk.yellow(
              "There was a problem watching the compiler output, changes in the contracts won't be reflected in the Hardhat EVM. Run Hardhat with --verbose to learn more."
            )
          );

          log(
            "Compilation output can't be watched. Please report this to help us improve Hardhat.\n",
            error
          );
          if (reporterRequired) {
            const { Reporter } = reporterRequired;
            Reporter.reportError(error);
          }
        }
      }

      // const networkConfig = config.networks[
      //   HARDHAT_NETWORK_NAME
      // ] as HardhatNetworkConfig;
      // logHardhatEvmAccounts(networkConfig);
    } catch (error) {
      if (HardhatError.isHardhatError(error)) {
        throw error;
      }

      throw new HardhatError(
        ERRORS.BUILTIN_TASKS.JSONRPC_SERVER_ERROR,
        {
          error: error.message
        },
        error
      );
    }
    if (watch) {
      await hre.run("deploy:run", { ...args, watchOnly: true });
    }
    await server.waitUntilClosed();
  });

task("etherscan-verify", "submit contract source code to etherscan")
  .addOptionalParam("apiKey", "etherscan api key", undefined, types.string)
  .addOptionalParam(
    "license",
    "SPDX license (useful if SPDX is not listed in the sources), need to be supported by etherscan: https://etherscan.io/contract-license-types",
    undefined,
    types.string
  )
  .addFlag(
    "forceLicense",
    "force the use of the license specified by --license option"
  )
  .addFlag(
    "solcInput",
    "fallback on solc-input (useful when etherscan fails on the minimum sources)"
  )
  .setAction(async (args, hre, runSuper) => {
    const etherscanApiKey = args.apiKey || process.env.ETHERSCAN_API_KEY;
    if (!etherscanApiKey) {
      throw new Error(
        `No Etherscan API KEY provided. Set it through comand line option or by setting the "ETHERSCAN_API_KEY" env variable`
      );
    }
    const solcInputsPath = await deploymentsManager.getSolcInputPath();
    await submitSources(hre, solcInputsPath, {
      etherscanApiKey,
      license: args.license,
      fallbackOnSolcInput: args.solcInput,
      forceLicense: args.forceLicense
    });
  });

const { spawn, exec } = require('child_process');
const http = require('http');
const { URL } = require('url');
const EventEmitter = require('events');

// Process states
const ProcessState = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  READY: 'ready',
  STOPPING: 'stopping',
  SHUTDOWN: 'shutdown'
};

// Stop strategies
const StopStrategy = {
  IMMEDIATELY: 'immediately',
  WAIT_FOR_INFLIGHT: 'wait_for_inflight'
};

class Process extends EventEmitter {
  constructor(id, healthCheckTimeout, config, processLogger, proxyLogger) {
    super();
    
    this.id = id;
    this.config = config;
    this.process = null;
    this.healthCheckTimeout = healthCheckTimeout;
    this.processLogger = processLogger;
    this.proxyLogger = proxyLogger;
    
    this.state = ProcessState.STOPPED;
    this.stateMutex = new Set(); // For state synchronization
    this.inFlightRequests = 0;
    this.failedStartCount = 0;
    this.lastRequestHandled = new Date(0);
    this.healthCheckLoopInterval = 5000; // 5 seconds
    
    // Create a reverse proxy target URL
    this.proxyUrl = new URL(this.config.proxy);
  }

  getCurrentState() {
    return this.state;
  }

  async setState(newState) {
    const oldState = this.state;
    this.state = newState;
    
    // Emit state change event
    this.emit('stateChange', { id: this.id, oldState, newState });
    
    this.proxyLogger.info(`<${this.id}> State transitioned from ${oldState} to ${newState}`);
  }

  async start() {
    // If process is already ready, return
    if (this.state === ProcessState.READY) {
      return true;
    }
    
    // If process is already starting, wait for it to complete
    if (this.state === ProcessState.STARTING) {
      while (this.state === ProcessState.STARTING) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return this.state === ProcessState.READY;
    }

    // Check if we're in a valid state to start
    if (this.state !== ProcessState.STOPPED && this.state !== ProcessState.STOPPING) {
      this.proxyLogger.error(`<${this.id}> Process is in invalid state to start: ${this.state}`);
      return false;
    }

    await this.setState(ProcessState.STARTING);

    try {
      // Parse command string into executable and arguments
      const [executable, ...args] = this.parseCommand(this.config.cmd);
      
      this.processLogger.info(`<${this.id}> Executing start command: ${this.config.cmd}`);
      
      // Start the process
      this.process = spawn(executable, args, {
        env: { ...process.env, ...this.parseEnv(this.config.env) }
      });

      // Handle process output
      this.process.stdout.on('data', (data) => {
        this.processLogger.info(`<${this.id}> ${data.toString()}`);
      });

      this.process.stderr.on('data', (data) => {
        this.processLogger.error(`<${this.id}> ${data.toString()}`);
      });

      this.process.on('close', (code) => {
        this.processLogger.info(`<${this.id}> Process exited with code ${code}`);
        this.handleProcessExit();
      });

      this.process.on('error', (err) => {
        this.processLogger.error(`<${this.id}> Process error: ${err.message}`);
      });

      // Wait a bit before checking health
      await new Promise(resolve => setTimeout(resolve, 250));

      // Check health endpoint if specified
      if (this.config.checkEndpoint !== 'none') {
        const healthUrl = new URL(this.config.checkEndpoint, this.config.proxy);
        const maxDuration = this.healthCheckTimeout * 1000; // Convert to milliseconds
        const checkStartTime = Date.now();

        let healthCheckPassed = false;
        while (!healthCheckPassed && (Date.now() - checkStartTime) < maxDuration) {
          // Check if state changed to something other than STARTING
          if (this.state !== ProcessState.STARTING) {
            this.processLogger.warn(`<${this.id}> Process state changed from STARTING to ${this.state}, stopping health check`);
            return false;
          }

          try {
            const status = await this.checkHealthEndpoint(healthUrl.href);
            if (status === 200) {
              this.proxyLogger.info(`<${this.id}> Health check passed on ${healthUrl.href}`);
              healthCheckPassed = true;
            } else {
              this.proxyLogger.debug(`<${this.id}> Health check returned status ${status} on ${healthUrl.href}`);
            }
          } catch (err) {
            this.proxyLogger.debug(`<${this.id}> Health check error on ${healthUrl.href}: ${err.message}`);
          }

          if (!healthCheckPassed) {
            await new Promise(resolve => setTimeout(resolve, this.healthCheckLoopInterval));
          }
        }

        if (!healthCheckPassed) {
          throw new Error(`Health check timed out after ${this.healthCheckTimeout}s`);
        }
      }

      // If TTL is set, start TTL check loop
      if (this.config.unloadAfter > 0) {
        this.startTTLCheck();
      }

      await this.setState(ProcessState.READY);
      this.failedStartCount = 0;
      return true;
    } catch (error) {
      this.proxyLogger.error(`<${this.id}> Failed to start process: ${error.message}`);
      await this.setState(ProcessState.STOPPED);
      return false;
    }
  }

  async stop(strategy = StopStrategy.IMMEDIATELY) {
    if (this.state === ProcessState.STOPPED || this.state === ProcessState.STOPPING || this.state === ProcessState.SHUTDOWN) {
      return;
    }

    this.proxyLogger.debug(`<${this.id}> Stopping process, current state: ${this.state}`);

    await this.setState(ProcessState.STOPPING);

    if (strategy === StopStrategy.WAIT_FOR_INFLIGHT) {
      // Wait for in-flight requests to complete
      while (this.inFlightRequests > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    this.stopCommand();
  }

  stopCommand() {
    if (!this.process) {
      this.proxyLogger.error(`<${this.id}> Process is null, cannot stop`);
      return;
    }

    try {
      // If a custom stop command is provided, use it
      if (this.config.cmdStop) {
        const stopCmd = this.config.cmdStop.replace('${PID}', this.process.pid);
        this.proxyLogger.debug(`<${this.id}> Executing stop command: ${stopCmd}`);
        
        exec(stopCmd, (error, stdout, stderr) => {
          if (error) {
            this.proxyLogger.error(`<${this.id}> Failed to execute stop command: ${error.message}`);
          } else {
            this.proxyLogger.info(`<${this.id}> Stop command executed successfully`);
          }
        });
      } else {
        // Send SIGTERM to the process
        this.process.kill('SIGTERM');
      }
    } catch (err) {
      this.proxyLogger.error(`<${this.id}> Error stopping process: ${err.message}`);
    }
  }

  handleProcessExit() {
    this.proxyLogger.debug(`<${this.id}> Process handleProcessExit called`);
    
    switch (this.state) {
      case ProcessState.STOPPING:
        this.setState(ProcessState.STOPPED).catch(err => {
          this.proxyLogger.error(`<${this.id}> Error setting STOPPED state: ${err.message}`);
        });
        break;
      case ProcessState.STARTING:
        this.proxyLogger.error(`<${this.id}> Process exited during startup`);
        this.setState(ProcessState.STOPPED).catch(err => {
          this.proxyLogger.error(`<${this.id}> Error setting STOPPED state: ${err.message}`);
        });
        break;
      default:
        this.proxyLogger.info(`<${this.id}> Process exited unexpectedly, setting to STOPPED`);
        this.setState(ProcessState.STOPPED).catch(err => {
          this.proxyLogger.error(`<${this.id}> Error setting STOPPED state: ${err.message}`);
        });
        break;
    }
  }

  async checkHealthEndpoint(healthUrl) {
    return new Promise((resolve, reject) => {
      const request = http.get(healthUrl, { timeout: 5000 }, (res) => {
        resolve(res.statusCode);
      });

      request.on('error', (err) => {
        reject(err);
      });

      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Health check timeout'));
      });
    });
  }

  startTTLCheck() {
    const maxDuration = this.config.unloadAfter * 1000; // Convert to milliseconds

    const ttlInterval = setInterval(async () => {
      if (this.state !== ProcessState.READY) {
        clearInterval(ttlInterval);
        return;
      }

      // Skip TTL check if there are in-flight requests
      if (this.inFlightRequests > 0) {
        return;
      }

      const timeSinceLastRequest = Date.now() - this.lastRequestHandled.getTime();
      if (timeSinceLastRequest > maxDuration) {
        this.proxyLogger.info(`<${this.id}> Unloading model, TTL of ${this.config.unloadAfter}s reached`);
        await this.stop(StopStrategy.IMMEDIATELY);
        clearInterval(ttlInterval);
      }
    }, 1000); // Check every second
  }

  addInFlightRequest() {
    this.inFlightRequests++;
    this.lastRequestHandled = new Date();
  }

  removeInFlightRequest() {
    this.inFlightRequests--;
    if (this.inFlightRequests < 0) this.inFlightRequests = 0;
  }

  parseCommand(cmdStr) {
    // Simple shell command parsing
    // This is a basic implementation - for production use, consider using a proper shell command parser
    const parts = cmdStr.trim().split(/\s+/);
    return parts;
  }

  parseEnv(envArray) {
    const envObj = {};
    for (const envString of envArray) {
      const [key, ...valueParts] = envString.split('=');
      const value = valueParts.join('=');
      envObj[key] = value;
    }
    return envObj;
  }
}

class ProcessGroup {
  constructor(id, config, proxyLogger, upstreamLogger) {
    this.id = id;
    this.config = config;
    this.proxyLogger = proxyLogger;
    this.upstreamLogger = upstreamLogger;
    
    const groupConfig = config.groups[id];
    if (!groupConfig) {
      throw new Error(`Unable to find configuration for group id: ${id}`);
    }

    this.swap = groupConfig.swap;
    this.exclusive = groupConfig.exclusive;
    this.persistent = groupConfig.persistent;

    this.processes = new Map();
    this.lastUsedProcess = '';

    // Create a Process for each member in the group
    for (const modelID of groupConfig.members) {
      const modelConfig = config.models[modelID];
      const process = new Process(modelID, config.healthCheckTimeout, modelConfig, 
                                  this.upstreamLogger, this.proxyLogger);
      this.processes.set(modelID, process);
    }
  }

  async proxyRequest(modelID, req, res) {
    if (!this.hasMember(modelID)) {
      throw new Error(`model ${modelID} not part of group ${this.id}`);
    }

    if (this.swap) {
      if (this.lastUsedProcess !== modelID) {
        // Stop the currently running process if it's different
        if (this.lastUsedProcess && this.processes.has(this.lastUsedProcess)) {
          const oldProcess = this.processes.get(this.lastUsedProcess);
          if (oldProcess.getCurrentState() === ProcessState.READY) {
            await oldProcess.stop(StopStrategy.WAIT_FOR_INFLIGHT);
          }
        }

        // Start the requested process
        const process = this.processes.get(modelID);
        const success = await process.start();
        if (!success) {
          throw new Error(`Failed to start process for model ${modelID}`);
        }
        
        this.lastUsedProcess = modelID;
      }
    }

    // Get the process and handle the request
    const process = this.processes.get(modelID);
    process.addInFlightRequest();

    try {
      // This is where the actual proxying would happen
      // For now, this is just a placeholder
      // Implement proper proxy logic to forward the request to the model's server
      res.status(501).json({ error: "Proxy implementation not fully implemented yet" });
    } finally {
      process.removeInFlightRequest();
    }
  }

  hasMember(modelName) {
    return this.config.groups[this.id].members.includes(modelName);
  }

  async stopProcess(modelID, strategy = StopStrategy.IMMEDIATELY) {
    if (!this.processes.has(modelID)) {
      throw new Error(`process not found for ${modelID}`);
    }

    if (this.lastUsedProcess === modelID) {
      this.lastUsedProcess = '';
    }

    const process = this.processes.get(modelID);
    await process.stop(strategy);
  }

  async stopProcesses(strategy = StopStrategy.IMMEDIATELY) {
    const processes = Array.from(this.processes.values());
    const stopPromises = processes.map(process => process.stop(strategy));
    await Promise.all(stopPromises);
  }

  async shutdown() {
    const processes = Array.from(this.processes.values());
    const shutdownPromises = processes.map(process => {
      process.stop(StopStrategy.IMMEDIATELY);
      return process.setState(ProcessState.SHUTDOWN);
    });
    await Promise.all(shutdownPromises);
  }
}

class ProcessManager {
  constructor(config, proxyLogger, upstreamLogger) {
    this.config = config;
    this.proxyLogger = proxyLogger;
    this.upstreamLogger = upstreamLogger;
    
    this.processGroups = new Map();
    this.shutdown = false;
    
    // ADD THIS: Track the last active group
    this.lastActiveGroup = null;

    // Create process groups
    for (const [groupID] of Object.entries(config.groups)) {
      const processGroup = new ProcessGroup(groupID, config, proxyLogger, upstreamLogger);
      this.processGroups.set(groupID, processGroup);
    }
  }

async swapProcessGroup(requestedModel) {
    const realModelName = this.config.aliases[requestedModel] ||
                          (this.config.models[requestedModel] ? requestedModel : null);

    if (!realModelName) {
      throw new Error(`Could not find real modelID for ${requestedModel}`);
    }

    const processGroup = this.findGroupByModelName(realModelName);
    if (!processGroup) {
      throw new Error(`Could not find process group for model ${requestedModel}`);
    }

    // Cross-group swapping
    if (this.lastActiveGroup && 
        this.lastActiveGroup !== processGroup && 
        !this.lastActiveGroup.persistent &&
        !processGroup.persistent) {
      
      this.proxyLogger.info(`Swapping from group ${this.lastActiveGroup.id} to ${processGroup.id}`);
      await this.lastActiveGroup.stopProcesses(StopStrategy.WAIT_FOR_INFLIGHT);
      
      // ✅ FIX: Clear the last used process
      this.lastActiveGroup.lastUsedProcess = '';
    }

    // Exclusive mode
    if (processGroup.exclusive) {
      this.proxyLogger.debug(`Exclusive mode for group ${processGroup.id}, stopping other process groups`);
      for (const [groupId, otherGroup] of this.processGroups) {
        if (groupId !== processGroup.id && !otherGroup.persistent) {
          await otherGroup.stopProcesses(StopStrategy.WAIT_FOR_INFLIGHT);
          otherGroup.lastUsedProcess = '';  // ✅ FIX: Clear
        }
      }
    }

    // Within-group swapping
    if (processGroup.swap && processGroup.lastUsedProcess !== realModelName) {
      if (processGroup.lastUsedProcess && processGroup.processes.has(processGroup.lastUsedProcess)) {
        const oldProcess = processGroup.processes.get(processGroup.lastUsedProcess);
        if (oldProcess.getCurrentState() === ProcessState.READY) {
          this.proxyLogger.info(`Swapping within group ${processGroup.id} from ${processGroup.lastUsedProcess} to ${realModelName}`);
          await oldProcess.stop(StopStrategy.WAIT_FOR_INFLIGHT);
          
          // ✅ FIX: Wait for it to actually stop
          while (oldProcess.getCurrentState() === ProcessState.STOPPING) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
    }

    // ✅ FIX: Update tracking BEFORE returning
    this.lastActiveGroup = processGroup;
    processGroup.lastUsedProcess = realModelName;  // ← THIS WAS MISSING!

    return { processGroup, realModelName };
  }


  findGroupByModelName(modelName) {
    for (const group of this.processGroups.values()) {
      if (group.hasMember(modelName)) {
        return group;
      }
    }
    return null;
  }

  realModelName(search) {
    if (this.config.models[search]) {
      return search;
    } else if (this.config.aliases[search]) {
      return this.config.aliases[search];
    } else {
      return null;
    }
  }

  async shutdownAll() {
    this.shutdown = true;
    const shutdownPromises = Array.from(this.processGroups.values()).map(group => group.shutdown());
    await Promise.all(shutdownPromises);
  }
}

module.exports = { Process, ProcessGroup, ProcessManager, ProcessState, StopStrategy };
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { program } = require('commander');
const fs = require('fs');
const path = require('path');
const ConfigLoader = require('./config-loader');
const { ProcessManager, ProcessState } = require('./process-manager');
const { createLogger, format, transports } = require('winston');

// Define command line options
program
  .option('-c, --config <path>', 'config file path', 'config.yaml')
  .option('-l, --listen <address>', 'listen address')
  .option('--tls-cert-file <path>', 'TLS certificate file')
  .option('--tls-key-file <path>', 'TLS key file')
  .option('--version', 'show version')
  .option('--watch-config', 'watch config file for changes');

program.parse();
const options = program.opts();

if (options.version) {
  console.log('model-swap Node.js version 1.0.0');
  process.exit(0);
}


// At the top of your file, after creating the app
const proxyCache = new Map();

function getOrCreateProxy(target, pathRewrite) {
  const cacheKey = `${target}:${JSON.stringify(pathRewrite)}`;
  
  if (!proxyCache.has(cacheKey)) {
    const proxy = createProxyMiddleware({
      target,
      changeOrigin: true,
      pathRewrite,
      logLevel: 'debug',
      
      // CRITICAL: Add these options for streaming support
      selfHandleResponse: false,
      ws: true,
      
      onProxyReq: (proxyReq, req, res) => {
        logger.debug(`Proxying ${req.method} ${req.path} to ${target}`);
        
        // Write the raw body if we have it
        if (req.rawBody) {
          // Set correct headers
          if (!proxyReq.getHeader('content-type')) {
            proxyReq.setHeader('Content-Type', req.headers['content-type'] || 'application/json');
          }
          proxyReq.setHeader('Content-Length', Buffer.byteLength(req.rawBody));
          
          // Write the body
          proxyReq.write(req.rawBody);
          proxyReq.end();
        }
      },
      
      onProxyRes: (proxyRes, req, res) => {
        logger.debug(`Received response with status ${proxyRes.statusCode}`);
        
        // For streaming responses, don't buffer
        if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
          logger.debug('Streaming response detected');
        }
      },
      
      onError: (err, req, res) => {
        logger.error(`Proxy error: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Proxy error: ' + err.message });
        }
      }
    });
    proxyCache.set(cacheKey, proxy);
  }
  
  return proxyCache.get(cacheKey);
}
// Create loggers
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      )
    })
  ]
});

// Load configuration
let configLoader;
let config;
let processManager;

try {
  configLoader = new ConfigLoader();
  config = configLoader.loadConfig(options.config);
  
  // Update logger level based on config
  logger.level = config.logLevel || 'info';
} catch (err) {
  logger.error(`Error loading config: ${err.message}`);
  process.exit(1);
}

// Create process manager
const upstreamLogger = createLogger({
  level: config.logLevel || 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      )
    })
  ]
});

processManager = new ProcessManager(config, logger, upstreamLogger);

// Create Express app
const app = express();

// Enable CORS
app.use(cors());

const getRawBody = require('raw-body');
const contentType = require('content-type');

app.use(async (req, res, next) => {
  // For routes that will be proxied, capture the raw body
  const proxyRoutes = [
    '/upstream/',
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/embeddings',
    '/reranking',
    '/rerank',
    '/v1/rerank',
    '/v1/reranking',
    '/infill',
    '/completion',
    '/v1/audio/speech',
    '/v1/audio/transcriptions'
  ];

  const needsRawBody = proxyRoutes.some(route => req.path.startsWith(route));

  if (needsRawBody && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
    try {
      const raw = await getRawBody(req, {
        length: req.headers['content-length'],
        limit: '50mb',
        encoding: contentType.parse(req).parameters.charset || 'utf-8'
      });
      req.rawBody = raw;
      
      // Also parse as JSON if applicable
      if (req.headers['content-type']?.includes('application/json')) {
        try {
          req.body = JSON.parse(raw);
        } catch (e) {
          logger.error(`JSON parse error: ${e.message}`);
        }
      }
    } catch (err) {
      logger.error(`Error reading raw body: ${err.message}`);
    }
    return next();
  }
  
  // For non-proxy routes, use regular JSON parsing
  express.json({ limit: '50mb' })(req, res, next);
});

app.use((req, res, next) => {
  if (req.path.startsWith('/upstream/')) {
    return next();
  }
  express.urlencoded({ extended: true, limit: '50mb' })(req, res, next);
});

// Remove this line - it's redundant:
// app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Handle multipart forms (for audio/speech, audio/transcriptions)
app.use('/v1/audio', express.raw({ type: 'multipart/form-data', limit: '50mb' }));

// Log requests if enabled
if (config.logRequests) {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info(`Request ${req.ip} "${req.method} ${req.path}" ${res.statusCode} ${res.get('Content-Length') || 0} "${req.get('User-Agent') || ''}" ${duration}ms`);
    });
    next();
  });
}

// Set up event broadcasting for server-sent events
const eventClients = new Set();
let metricsData = [];

// Add event listener for process state changes
function setupProcessStateListeners() {
  for (const group of processManager.processGroups.values()) {
    for (const process of group.processes.values()) {
      process.removeAllListeners('stateChange'); // Remove any existing listeners to avoid duplicates
      process.on('stateChange', (stateChange) => {
        // Broadcast model status update
        const modelStatusUpdate = {
          type: "modelStatus",
          data: JSON.stringify(getAllModelStatuses())
        };
        broadcastEvent(modelStatusUpdate);
      });
    }
  }
}

setupProcessStateListeners();

function broadcastEvent(event) {
  const eventData = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of eventClients) {
    try {
      client.write(eventData);
    } catch (err) {
      // Client disconnected
      eventClients.delete(client);
    }
  }
}

function getAllModelStatuses() {
  const statuses = [];

  for (const [groupId, group] of processManager.processGroups) {
    for (const [modelId, process] of group.processes) {
      const modelConfig = config.models[modelId];
      statuses.push({
        id: modelId,
        state: process.getCurrentState(),
        name: modelConfig.name || '',
        description: modelConfig.description || '',
        unlisted: !!modelConfig.unlisted
      });
    }
  }

  return statuses;
}


// API endpoints
app.use((req, res, next) => {
  logger.info(`Incoming request: ${req.method} ${req.path} (original: ${req.originalUrl})`);
  next();
});
// Server-sent events endpoint for real-time updates
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send initial data
  const initialModelStatus = {
    type: "modelStatus",
    data: JSON.stringify(getAllModelStatuses())
  };
  res.write(`data: ${JSON.stringify(initialModelStatus)}\n\n`);

  eventClients.add(res);

  req.on('close', () => {
    eventClients.delete(res);
  });
});

// List available models (Go version API compatibility)
app.get('/api/models/', (req, res) => {
  const data = [];
  const createdTime = Math.floor(Date.now() / 1000);

  for (const [id, modelConfig] of Object.entries(config.models)) {
    if (modelConfig.unlisted) {
      continue;
    }

    const newRecord = (modelId) => {
      const record = {
        id: modelId,
        object: 'model',
        created: createdTime,
        owned_by: 'model-swap',
      };

      if (modelConfig.name && modelConfig.name.trim() !== '') {
        record.name = modelConfig.name.trim();
      }
      if (modelConfig.description && modelConfig.description.trim() !== '') {
        record.description = modelConfig.description.trim();
      }

      // Add metadata if present
      if (modelConfig.metadata && Object.keys(modelConfig.metadata).length > 0) {
        record.meta = {
          llamaswap: modelConfig.metadata
        };
      }
      return record;
    };

    data.push(newRecord(id));

    // Include aliases
    if (config.includeAliasesInList && modelConfig.aliases) {
      for (const alias of modelConfig.aliases) {
        if (alias && alias.trim() !== '') {
          data.push(newRecord(alias.trim()));
        }
      }
    }
  }

  // Sort by the "id" key
  data.sort((a, b) => a.id.localeCompare(b.id));

  // Set CORS headers if origin exists
  if (req.get('Origin')) {
    res.header('Access-Control-Allow-Origin', req.get('Origin'));
  }

  res.json({
    object: 'list',
    data: data
  });
});

// Unload all models (Go version API compatibility)
app.post('/api/models/unload', async (req, res) => {
  try {
    await processManager.shutdownAll();
    res.status(200).send('OK');
  } catch (err) {
    logger.error(`Error unloading models: ${err.message}`);
    res.status(500).json({ error: 'Error unloading models' });
  }
});

// Unload specific model (Go version API compatibility)
app.post('/api/models/unload/:model', async (req, res) => {
  const modelName = req.params.model;

  try {
    // Find the process group that contains this model
    const processGroup = processManager.findGroupByModelName(modelName);
    if (!processGroup) {
      return res.status(404).json({ error: `Model ${modelName} not found` });
    }

    // Stop the specific process
    await processGroup.stopProcess(modelName);
    res.status(200).send('OK');
  } catch (err) {
    logger.error(`Error unloading model ${modelName}: ${err.message}`);
    res.status(500).json({ error: `Error unloading model: ${err.message}` });
  }
});

// Load model via upstream path and proxy to its service root
app.get('/upstream/:model/', async (req, res) => {
  const modelName = req.params.model;

  try {
    const { processGroup, realModelName } = await processManager.swapProcessGroup(modelName);

    // Get the specific process for this model and ensure it's ready
    const process = processGroup.processes.get(realModelName);
    if (!process) {
      throw new Error(`Could not find process for model ${realModelName}`);
    }

    // Start the process if it's not already ready
    if (process.getCurrentState() !== ProcessState.READY) {
      logger.info(`<${realModelName}> Starting model process...`);
      const success = await process.start();
      if (!success) {
        throw new Error(`Failed to start process for model ${realModelName}`);
      }
      logger.info(`<${realModelName}> Model process started successfully`);
    }

    // Get the model's proxy configuration
    const modelConfig = config.models[realModelName];
    if (!modelConfig || !modelConfig.proxy) {
      throw new Error(`No proxy configuration found for model ${realModelName}`);
    }

    // Use the http-proxy-middleware to proxy the request to the model's service
    const proxyOptions = {
      target: modelConfig.proxy,
      changeOrigin: true,
      pathRewrite: {
        [`^/upstream/${modelName}`]: ''  // Remove the /upstream/modelname part
      },
      onProxyReq: (proxyReq, req, res) => {
        logger.debug(`<${realModelName}> Proxying request to ${modelConfig.proxy}`);
      },
      onProxyRes: (proxyRes, req, res) => {
        logger.debug(`<${realModelName}> Received response with status ${proxyRes.statusCode}`);
      }
    };

    // Apply the proxy middleware
    createProxyMiddleware(proxyOptions)(req, res, () => {
      res.status(500).json({ error: 'Proxy error' });
    });
  } catch (err) {
    logger.error(`Error loading model: ${err.message}`);
    res.status(500).json({ error: `error loading model: ${err.message}` });
  }
});

// List available models
app.get('/v1/models', (req, res) => {
  const data = [];
  const createdTime = Math.floor(Date.now() / 1000);

  for (const [id, modelConfig] of Object.entries(config.models)) {
    if (modelConfig.unlisted) {
      continue;
    }

    const newRecord = (modelId) => {
      const record = {
        id: modelId,
        object: 'model',
        created: createdTime,
        owned_by: 'model-swap',
      };

      if (modelConfig.name && modelConfig.name.trim() !== '') {
        record.name = modelConfig.name.trim();
      }
      if (modelConfig.description && modelConfig.description.trim() !== '') {
        record.description = modelConfig.description.trim();
      }

      // Add metadata if present
      if (modelConfig.metadata && Object.keys(modelConfig.metadata).length > 0) {
        record.meta = {
          llamaswap: modelConfig.metadata
        };
      }
      return record;
    };

    data.push(newRecord(id));

    // Include aliases
    if (config.includeAliasesInList && modelConfig.aliases) {
      for (const alias of modelConfig.aliases) {
        if (alias && alias.trim() !== '') {
          data.push(newRecord(alias.trim()));
        }
      }
    }
  }

  // Sort by the "id" key
  data.sort((a, b) => a.id.localeCompare(b.id));

  // Set CORS headers if origin exists
  if (req.get('Origin')) {
    res.header('Access-Control-Allow-Origin', req.get('Origin'));
  }

  res.json({
    object: 'list',
    data: data
  });
});

// Proxy OpenAI API requests
// Update your /v1/chat/completions route to properly handle streaming
app.post('/v1/chat/completions', async (req, res) => {
  const requestedModel = req.body.model;
  if (!requestedModel) {
    return res.status(400).json({ error: 'missing or invalid \'model\' key' });
  }

  const { config: modelConfig, name: realModelName, found } = configLoader.findConfig(requestedModel);
  if (!found) {
    return res.status(400).json({ error: `could not find real modelID for ${requestedModel}` });
  }

  try {
    const { processGroup, realModelName } = await processManager.swapProcessGroup(requestedModel);

    const process = processGroup.processes.get(realModelName);
    if (!process) {
      throw new Error(`Could not find process for model ${realModelName}`);
    }

    if (process.getCurrentState() !== ProcessState.READY) {
      logger.info(`<${realModelName}> Starting model process...`);
      const success = await process.start();
      if (!success) {
        throw new Error(`Failed to start process for model ${realModelName}`);
      }
      logger.info(`<${realModelName}> Model process started successfully`);
    }

    // Modify the request body
    if (modelConfig.useModelName) {
      req.body.model = modelConfig.useModelName;
    }

    if (modelConfig.filters && modelConfig.filters.stripParams) {
      const stripParams = modelConfig.filters.stripParams.split(',')
        .map(param => param.trim())
        .filter(param => param !== 'model' && param !== '');

      for (const param of stripParams) {
        delete req.body[param];
      }
    }

    // ✅ CRITICAL: Update rawBody after modifying body
    req.rawBody = JSON.stringify(req.body);

    logger.info(`Proxying /v1/chat/completions to ${modelConfig.proxy}/v1/chat/completions`);

    const proxy = getOrCreateProxy(modelConfig.proxy, {
      '^/v1/chat/completions': '/v1/chat/completions'
    });
    
    proxy(req, res);
    
  } catch (err) {
    logger.error(`Error proxying request: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: `error proxying request: ${err.message}` });
    }
  }
});



// Support for other OpenAI API endpoints
const openaiEndpoints = [
  '/v1/completions',
  '/v1/embeddings',
  '/reranking',
  '/rerank',
  '/v1/rerank',
  '/v1/reranking',
  '/infill',
  '/completion',
  '/v1/audio/speech',
  '/v1/audio/transcriptions'
];

for (const endpoint of openaiEndpoints) {
  app.post(endpoint, async (req, res) => {
    const requestedModel = endpoint.includes('/audio/transcriptions') 
      ? req.query.model || (req.body && req.body.model) 
      : req.body.model;
      
    if (!requestedModel) {
      return res.status(400).json({ error: 'missing or invalid \'model\' key' });
    }

    const { config: modelConfig, name: realModelName, found } = configLoader.findConfig(requestedModel);
    if (!found) {
      return res.status(400).json({ error: `could not find real modelID for ${requestedModel}` });
    }

    try {
      const { processGroup, realModelName } = await processManager.swapProcessGroup(requestedModel);

      // Get the specific process for this model and ensure it's ready
      const process = processGroup.processes.get(realModelName);
      if (!process) {
        throw new Error(`Could not find process for model ${realModelName}`);
      }

      // Start the process if it's not already ready
      if (process.getCurrentState() !== ProcessState.READY) {
        logger.info(`<${realModelName}> Starting model process...`);
        const success = await process.start();
        if (!success) {
          throw new Error(`Failed to start process for model ${realModelName}`);
        }
        logger.info(`<${realModelName}> Model process started successfully`);
      }

      // Modify the request to use the correct model name if needed
      if (modelConfig.useModelName) {
        if (req.body && req.body.model) {
          req.body.model = modelConfig.useModelName;
        } else if (req.query && req.query.model) {
          req.query.model = modelConfig.useModelName;
        }
      }

      // Strip parameters if configured
      if (modelConfig.filters && modelConfig.filters.stripParams) {
        const stripParams = modelConfig.filters.stripParams.split(',')
          .map(param => param.trim())
          .filter(param => param !== 'model' && param !== '');

        if (req.body) {
          for (const param of stripParams) {
            delete req.body[param];
          }
        }
      }

      // Proxy the request to the model's server
      const proxyOptions = {
        target: modelConfig.proxy,
        changeOrigin: true,
        pathRewrite: {
          [`^${endpoint}`]: endpoint
        },
        onProxyReq: (proxyReq, req, res) => {
          logger.debug(`<${realModelName}> Proxying request to ${modelConfig.proxy}`);
        },
        onProxyRes: (proxyRes, req, res) => {
          logger.debug(`<${realModelName}> Received response with status ${proxyRes.statusCode}`);
        }
      };

      // Apply the proxy middleware
      createProxyMiddleware(proxyOptions)(req, res, () => {
        res.status(500).json({ error: 'Proxy error' });
      });
    } catch (err) {
      logger.error(`Error proxying request: ${err.message}`);
      res.status(500).json({ error: `error proxying request: ${err.message}` });
    }
  });
}

app.all('/upstream/*', async (req, res) => {
  const upstreamPath = req.params[0];
  
  const parts = upstreamPath.split('/').filter(part => part !== '');
  if (parts.length === 0) {
    return res.status(400).json({ error: 'model id required in path' });
  }

  let modelFound = false;
  let searchModelName = '';
  let modelName = '';
  let remainingPath = '';

  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue;

    if (searchModelName === '') {
      searchModelName = parts[i];
    } else {
      searchModelName = searchModelName + '/' + parts[i];
    }

    if (configLoader.realModelName(searchModelName)) {
      modelName = configLoader.realModelName(searchModelName);
      remainingPath = '/' + parts.slice(i + 1).join('/');
      modelFound = true;
      
      if (remainingPath === '/' && !upstreamPath.endsWith('/')) {
        const newPath = `/upstream/${searchModelName}/`;
        const query = req.url.split('?')[1];
        res.redirect(301, query ? `${newPath}?${query}` : newPath);
        return;
      }
      break;
    }
  }

  if (!modelFound) {
    return res.status(400).json({ error: 'model id required in path' });
  }

  try {
    const { processGroup, realModelName } = await processManager.swapProcessGroup(modelName);
    const modelConfig = config.models[realModelName];
    const process = processGroup.processes.get(realModelName);
    
    if (!process) {
      throw new Error(`Could not find process for model ${realModelName}`);
    }

    if (process.getCurrentState() !== ProcessState.READY) {
      logger.info(`<${realModelName}> Starting model process...`);
      const success = await process.start();
      if (!success) {
        throw new Error(`Failed to start process for model ${realModelName}`);
      }
      logger.info(`<${realModelName}> Model process started successfully`);
    }

    // Log what we're about to proxy
    logger.info(`Proxying /upstream/${searchModelName}${remainingPath} to ${modelConfig.proxy}${remainingPath}`);

    // Use the cached proxy
    const proxy = getOrCreateProxy(modelConfig.proxy, {
      [`^/upstream/${searchModelName}`]: ''  // This will strip /upstream/modelName
    });
    
    proxy(req, res);
    
  } catch (err) {
    logger.error(`Error proxying upstream request: ${err.message}`);
    res.status(500).json({ error: `error proxying request: ${err.message}` });
  }
});


// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Get running models
app.get('/running', (req, res) => {
  const runningProcesses = [];

  for (const [groupId, group] of processManager.processGroups) {
    for (const [modelId, process] of group.processes) {
      if (process.getCurrentState() === ProcessState.READY) {
        runningProcesses.push({
          model: modelId,
          state: process.getCurrentState()
        });
      }
    }
  }

  res.json({ running: runningProcesses });
});

// llama.cpp props endpoint - proxy to currently active model
app.get('/props', async (req, res) => {
  // Find the currently active model (the most recently started)
  let activeModel = null;
  let latestStartTime = 0;

  for (const [groupId, group] of processManager.processGroups) {
    for (const [modelId, process] of group.processes) {
      if (process.getCurrentState() === ProcessState.READY) {
        if (process.startTime && process.startTime > latestStartTime) {
          latestStartTime = process.startTime;
          activeModel = modelId;
        }
      }
    }
  }

  if (!activeModel) {
    // If no model is active, return proper server props structure
    return res.json({
      default_generation_settings: {
        id: 1,
        id_task: 1,
        n_ctx: 4096,
        speculative: false,
        is_processing: false,
        params: {
          n_predict: -1,
          seed: -1,
          temperature: 0.8,
          dynatemp_range: 0.0,
          dynatemp_exponent: 1.0,
          top_k: 40,
          top_p: 0.95,
          min_p: 0.05,
          top_n_sigma: 0.0,
          xtc_probability: 0.0,
          xtc_threshold: 0.1,
          typ_p: 1.0,
          repeat_last_n: 64,
          repeat_penalty: 1.0,
          presence_penalty: 0.0,
          frequency_penalty: 0.0,
          dry_multiplier: 0.0,
          dry_base: 1.75,
          dry_allowed_length: 2,
          dry_penalty_last_n: -1,
          dry_sequence_breakers: ["\n", "}", "]", '"'],
          mirostat: 0,
          mirostat_tau: 5.0,
          mirostat_eta: 0.1,
          stop: [],
          max_tokens: -1,
          n_keep: 0,
          n_discard: 0,
          ignore_eos: false,
          stream: true,
          logit_bias: [],
          n_probs: 0,
          min_keep: 0,
          grammar: "",
          grammar_lazy: true,
          grammar_triggers: [],
          preserved_tokens: [],
          chat_format: "chatml",
          reasoning_format: "auto",
          reasoning_in_content: true,
          thinking_forced_open: false,
          samplers: ["top_k", "top_p", "min_p", "temperature"],
          "speculative.n_max": 0,
          "speculative.n_min": 0,
          "speculative.p_min": 0.9,
          timings_per_token: false,
          post_sampling_probs: 0,
          lora: []
        },
        prompt: "",
        next_token: {
          has_next_token: true,
          has_new_line: false,
          n_remain: -1,
          n_decoded: 0,
          stopping_word: ""
        }
      },
      total_slots: 1,
      model_path: "",
      modalities: {
        vision: false,
        audio: false
      },
      chat_template: "chatml",
      bos_token: "<|begin_of_text|>",
      eos_token: "<|end_of_text|>",
      build_info: "llama.cpp"
    });
  }

  // Get the model config to determine where to proxy
  const modelConfig = config.models[activeModel];
  if (!modelConfig || !modelConfig.proxy) {
    return res.status(500).json({ error: `No proxy configuration for model ${activeModel}` });
  }

  // Create a proxy to the actual model's props endpoint
  const proxy = getOrCreateProxy(modelConfig.proxy, {
    '^/props': '/props'
  });

  proxy(req, res);
});

// llama.cpp slots endpoint - proxy to currently active model
app.get('/slots', async (req, res) => {
  // Find the currently active model (the most recently started)
  let activeModel = null;
  let latestStartTime = 0;

  for (const [groupId, group] of processManager.processGroups) {
    for (const [modelId, process] of group.processes) {
      if (process.getCurrentState() === ProcessState.READY) {
        if (process.startTime && process.startTime > latestStartTime) {
          latestStartTime = process.startTime;
          activeModel = modelId;
        }
      }
    }
  }

  if (!activeModel) {
    // If no model is active, return empty slots array
    return res.json([]);
  }

  // Get the model config to determine where to proxy
  const modelConfig = config.models[activeModel];
  if (!modelConfig || !modelConfig.proxy) {
    return res.status(500).json({ error: `No proxy configuration for model ${activeModel}` });
  }

  // Create a proxy to the actual model's slots endpoint
  const proxy = getOrCreateProxy(modelConfig.proxy, {
    '^/slots': '/slots'
  });

  proxy(req, res);
});

// Unload all models
app.get('/unload', async (req, res) => {
  try {
    await processManager.shutdownAll();
    res.status(200).send('OK');
  } catch (err) {
    logger.error(`Error unloading models: ${err.message}`);
    res.status(500).json({ error: 'Error unloading models' });
  }
});

// Static file serving for UI
const UI_DIR = path.join(__dirname, 'dist', 'ui');

// Serve static files from the UI directory
app.use('/ui', express.static(UI_DIR));

// Catch-all route to serve the UI for any route under /ui
app.get('/ui/*', (req, res) => {
  res.sendFile(path.join(UI_DIR, 'index.html'));
});

// Set up signal handlers for graceful shutdown
let isShuttingDown = false;

const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logger.info('Received shutdown signal, shutting down gracefully...');
  
  try {
    await processManager.shutdownAll();
    logger.info('All processes stopped, exiting.');
    process.exit(0);
  } catch (err) {
    logger.error(`Error during shutdown: ${err.message}`);
    process.exit(1);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the server
const listenAddr = options.listen || ':8080';
const [host, port] = listenAddr.startsWith(':') ? ['0.0.0.0', listenAddr.substring(1)] : listenAddr.split(':');
const portNum = parseInt(port, 10);

if (isNaN(portNum)) {
  logger.error('Invalid port number');
  process.exit(1);
}

// Check if TLS options are provided
const useTLS = options.tlsCertFile && options.tlsKeyFile;

if (useTLS && (!options.tlsCertFile || !options.tlsKeyFile)) {
  logger.error('Both --tls-cert-file and --tls-key-file must be provided for TLS');
  process.exit(1);
}

if (useTLS) {
  const https = require('https');
  const fs = require('fs');
  
  try {
    const cert = fs.readFileSync(options.tlsCertFile);
    const key = fs.readFileSync(options.tlsKeyFile);
    
    https.createServer({ cert, key }, app).listen(portNum, host, () => {
      logger.info(`model-swap listening with TLS on https://${host}:${portNum}`);
    });
  } catch (err) {
    logger.error(`Error starting HTTPS server: ${err.message}`);
    process.exit(1);
  }
} else {
  app.listen(portNum, host, () => {
    logger.info(`model-swap listening on http://${host}:${portNum}`);
  });
}

// Run preload hooks if configured
if (config.hooks.on_startup.preload && config.hooks.on_startup.preload.length > 0) {
  setTimeout(async () => {
    logger.info('Running startup hooks...');
    for (const modelName of config.hooks.on_startup.preload) {
      logger.info(`Preloading model: ${modelName}`);
      try {
        const { processGroup } = await processManager.swapProcessGroup(modelName);
        logger.info(`Successfully preloaded model: ${modelName}`);
      } catch (err) {
        logger.error(`Failed to preload model ${modelName}: ${err.message}`);
      }
    }
  }, 1000); // Delay preload slightly to allow server to start
}
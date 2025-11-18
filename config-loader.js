const fs = require('fs');
const yaml = require('yaml');

// Regular expressions for macro validation
const macroNameRegex = /^[a-zA-Z0-9_-]+$/;
const macroPatternRegex = /\$\{([a-zA-Z0-9_-]+)\}/g;

class ConfigLoader {
  constructor() {
    this.config = {
      healthCheckTimeout: 120,
      logRequests: false,
      logLevel: 'info',
      logTimeFormat: '',
      metricsMaxInMemory: 1000,
      models: {},
      profiles: {},
      groups: {},
      macros: {},
      aliases: {},
      startPort: 5800,
      hooks: {
        on_startup: {
          preload: []
        }
      },
      sendLoadingState: false,
      includeAliasesInList: false
    };
  }

  // Validate macro name and value constraints
  validateMacro(name, value) {
    if (name.length >= 64) {
      throw new Error(`macro name '${name}' exceeds maximum length of 63 characters`);
    }
    if (!macroNameRegex.test(name)) {
      throw new Error(`macro name '${name}' contains invalid characters, must match pattern ^[a-zA-Z0-9_-]+$`);
    }

    // Validate that value is a scalar type
    if (typeof value === 'string') {
      if (value.length >= 1024) {
        throw new Error(`macro value for '${name}' exceeds maximum length of 1024 characters`);
      }
      // Check for self-reference
      const macroSlug = `\${${name}}`;
      if (value.includes(macroSlug)) {
        throw new Error(`macro '${name}' contains self-reference`);
      }
    } else if (['number', 'boolean'].includes(typeof value)) {
      // These types are allowed
    } else {
      throw new Error(`macro '${name}' has invalid type ${typeof value}, must be a scalar type (string, number, or boolean)`);
    }

    if (['PORT', 'MODEL_ID'].includes(name)) {
      throw new Error(`macro name '${name}' is reserved`);
    }

    return true;
  }

  // Recursively substitute a single macro in a value structure
  substituteMacroInValue(value, macroName, macroValue) {
    const macroSlug = `\${${macroName}}`;
    const macroStr = String(macroValue);

    if (typeof value === 'string') {
      // Check if this is a direct macro substitution
      if (value === macroSlug) {
        return macroValue;
      }
      // Handle string interpolation
      if (value.includes(macroSlug)) {
        // Escape special regex characters in the macro slug
        const escapedMacroSlug = macroSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return value.replace(new RegExp(escapedMacroSlug, 'g'), macroStr);
      }
      return value;
    } else if (Array.isArray(value)) {
      // Recursively process array elements
      return value.map(item => this.substituteMacroInValue(item, macroName, macroValue));
    } else if (value && typeof value === 'object' && value.constructor === Object) {
      // Recursively process object values
      const newObj = {};
      for (const [key, val] of Object.entries(value)) {
        newObj[key] = this.substituteMacroInValue(val, macroName, macroValue);
      }
      return newObj;
    } else {
      // Return scalar types as-is
      return value;
    }
  }

  // Validate metadata for unknown macros
  validateMetadataForUnknownMacros(value, modelId) {
    if (typeof value === 'string') {
      const matches = value.match(macroPatternRegex);
      if (matches) {
        for (const match of matches) {
          const macroName = match.slice(2, -1); // Extract name from ${name}
          throw new Error(`model ${modelId} metadata: unknown macro '\${${macroName}}'`);
        }
      }
      return true;
    } else if (Array.isArray(value)) {
      for (const val of value) {
        this.validateMetadataForUnknownMacros(val, modelId);
      }
      return true;
    } else if (value && typeof value === 'object' && value.constructor === Object) {
      for (const val of Object.values(value)) {
        this.validateMetadataForUnknownMacros(val, modelId);
      }
      return true;
    } else {
      // Scalar types don't contain macros
      return true;
    }
  }

  // Strip comments from command strings
  stripComments(cmdStr) {
    const lines = cmdStr.split('\n');
    const cleanedLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comment lines
      if (trimmed.startsWith('#')) {
        continue;
      }
      cleanedLines.push(line);
    }

    return cleanedLines.join('\n');
  }

  // Add default group to config if no groups exist
  addDefaultGroupToConfig(config) {
    if (!config.groups) {
      config.groups = {};
    }

    const defaultGroup = {
      swap: true,
      exclusive: true,
      persistent: false,
      members: []
    };

    // If groups is empty, create a default group and put all models into it
    if (Object.keys(config.groups).length === 0) {
      for (const modelName in config.models) {
        defaultGroup.members.push(modelName);
      }
    } else {
      // Iterate over existing group members and add non-grouped models into the default group
      for (const modelName in config.models) {
        let foundModel = false;

        // Search for the model in existing groups
        for (const groupConfig of Object.values(config.groups)) {
          if (groupConfig.members.includes(modelName)) {
            foundModel = true;
            break;
          }
        }

        if (!foundModel) {
          defaultGroup.members.push(modelName);
        }
      }
    }

    // Sort members for consistent ordering
    defaultGroup.members.sort();
    config.groups['(default)'] = defaultGroup;

    return config;
  }

  loadConfig(path) {
    try {
      const data = fs.readFileSync(path, 'utf8');
      const yamlData = yaml.parse(data);

      // Merge with default config
      this.config = { ...this.config, ...yamlData };

      // Validate health check timeout
      if (this.config.healthCheckTimeout < 15) {
        this.config.healthCheckTimeout = 15; // Set minimum of 15 seconds
      }

      if (this.config.startPort < 1) {
        throw new Error('startPort must be greater than 1');
      }

      // Validate macros
      for (const [name, value] of Object.entries(this.config.macros)) {
        this.validateMacro(name, value);
      }

      // Populate aliases map
      this.config.aliases = {};
      for (const [modelName, modelConfig] of Object.entries(this.config.models)) {
        if (modelConfig.aliases) {
          for (const alias of modelConfig.aliases) {
            if (this.config.aliases[alias]) {
              throw new Error(`duplicate alias ${alias} found in model: ${modelName}`);
            }
            this.config.aliases[alias] = modelName;
          }
        }
      }

      // Process each model configuration
      let nextPort = this.config.startPort;
      const modelIds = Object.keys(this.config.models).sort(); // Sort for consistent processing

      for (const modelId of modelIds) {
        let modelConfig = { ...this.config.models[modelId] };

        // Set default values if not provided
        if (!modelConfig.proxy) {
          modelConfig.proxy = 'http://localhost:${PORT}';
        }
        if (!modelConfig.checkEndpoint) {
          modelConfig.checkEndpoint = '/health';
        }
        if (!modelConfig.aliases) {
          modelConfig.aliases = [];
        }
        if (!modelConfig.env) {
          modelConfig.env = [];
        }
        if (!modelConfig.macros) {
          modelConfig.macros = {};
        }
        if (!modelConfig.filters) {
          modelConfig.filters = { stripParams: '' };
        }
        if (!modelConfig.metadata) {
          modelConfig.metadata = {};
        }

        // Strip comments from command fields
        modelConfig.cmd = this.stripComments(modelConfig.cmd);
        if (modelConfig.cmdStop) {
          modelConfig.cmdStop = this.stripComments(modelConfig.cmdStop);
        }

        // Validate model-specific macros
        for (const [name, value] of Object.entries(modelConfig.macros)) {
          this.validateMacro(name, value);
        }

        // Merge global and model-specific macros (model takes precedence)
        const mergedMacros = { ...this.config.macros, ...modelConfig.macros };
        mergedMacros.MODEL_ID = modelId; // Always available

        // Check if PORT macro is needed BEFORE processing other macros
        const cmdHasPortOriginal = modelConfig.cmd.includes('${PORT}');
        const proxyHasPortOriginal = modelConfig.proxy.includes('${PORT}');

        if (cmdHasPortOriginal || proxyHasPortOriginal) {
          if (!cmdHasPortOriginal && proxyHasPortOriginal) {
            throw new Error(`model ${modelId}: proxy uses \${PORT} but cmd does not - \${PORT} is only available when used in cmd`);
          }

          // Add PORT macro
          mergedMacros.PORT = nextPort;
          nextPort++;
        }

        // Process macros in reverse order (LIFO - last defined first)
        // This allows later macros to reference earlier ones
        const macroNames = Object.keys(mergedMacros).reverse();
        for (const macroName of macroNames) {
          const macroValue = mergedMacros[macroName];
          modelConfig.cmd = this.substituteMacroInValue(modelConfig.cmd, macroName, macroValue);
          if (modelConfig.cmdStop) {
            modelConfig.cmdStop = this.substituteMacroInValue(modelConfig.cmdStop, macroName, macroValue);
          }
          modelConfig.proxy = this.substituteMacroInValue(modelConfig.proxy, macroName, macroValue);
          modelConfig.checkEndpoint = this.substituteMacroInValue(modelConfig.checkEndpoint, macroName, macroValue);
          modelConfig.filters.stripParams = this.substituteMacroInValue(modelConfig.filters.stripParams, macroName, macroValue);

          // Process metadata (recursive)
          if (modelConfig.metadata && Object.keys(modelConfig.metadata).length > 0) {
            modelConfig.metadata = this.substituteMacroInValue(modelConfig.metadata, macroName, macroValue);
          }
        }

        // Check for unknown macros in command fields
        const fieldMap = {
          'cmd': modelConfig.cmd,
          'cmdStop': modelConfig.cmdStop || '',
          'proxy': modelConfig.proxy,
          'checkEndpoint': modelConfig.checkEndpoint,
          'filters.stripParams': modelConfig.filters.stripParams
        };

        for (const [fieldName, fieldValue] of Object.entries(fieldMap)) {
          if (!fieldValue) continue;

          const matches = fieldValue.match(macroPatternRegex);
          if (matches) {
            for (const match of matches) {
              const macroName = match.slice(2, -1); // Extract name from ${name}

              if (macroName === 'PID' && fieldName === 'cmdStop') {
                continue; // This is ok, has to be replaced by process later
              }

              // Reserved macros should have been substituted already
              if (['PORT', 'MODEL_ID'].includes(macroName)) {
                throw new Error(`macro '\${${macroName}}' should have been substituted in ${modelId}.${fieldName}`);
              }

              // Any other macro is unknown
              throw new Error(`unknown macro '\${${macroName}}' found in ${modelId}.${fieldName}`);
            }
          }
        }

        // Validate metadata for unknown macros
        if (modelConfig.metadata && Object.keys(modelConfig.metadata).length > 0) {
          this.validateMetadataForUnknownMacros(modelConfig.metadata, modelId);
        }

        // Validate proxy URL
        try {
          new URL(modelConfig.proxy);
        } catch (err) {
          throw new Error(`model ${modelId}: invalid proxy URL: ${err.message}`);
        }

        this.config.models[modelId] = modelConfig;
      }

      // Add default group
      this.config = this.addDefaultGroupToConfig(this.config);

      // Check that members are all unique in the groups
      const memberUsage = {}; // maps member to group it appears in
      for (const [groupID, groupConfig] of Object.entries(this.config.groups)) {
        const prevSet = new Set();
        for (const member of groupConfig.members) {
          // Check for duplicates within this group
          if (prevSet.has(member)) {
            throw new Error(`duplicate model member ${member} found in group: ${groupID}`);
          }
          prevSet.add(member);

          // Check if member is used in another group
          if (memberUsage[member]) {
            throw new Error(`model member ${member} is used in multiple groups: ${memberUsage[member]} and ${groupID}`);
          }
          memberUsage[member] = groupID;
        }
      }

      // Clean up hooks preload
      if (this.config.hooks.on_startup.preload && this.config.hooks.on_startup.preload.length > 0) {
        const toPreload = [];
        for (const modelID of this.config.hooks.on_startup.preload) {
          const trimmedModelID = modelID.trim();
          if (trimmedModelID === '') continue;
          
          if (this.realModelName(trimmedModelID)) {
            toPreload.push(trimmedModelID);
          }
        }
        this.config.hooks.on_startup.preload = toPreload;
      }

      return this.config;
    } catch (err) {
      throw new Error(`Error loading config: ${err.message}`);
    }
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

  findConfig(modelName) {
    const realName = this.realModelName(modelName);
    if (!realName) {
      return { config: null, name: null, found: false };
    }
    return { config: this.config.models[realName], name: realName, found: true };
  }
}

module.exports = ConfigLoader;
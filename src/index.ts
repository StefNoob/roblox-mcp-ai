#!/usr/bin/env node

/**
 * Roblox Studio MCP Server
 * 
 * This server provides Model Context Protocol (MCP) tools for interacting with Roblox Studio.
 * It allows AI assistants to access Studio data, scripts, and objects through a bridge plugin.
 * 
 * Usage:
 *   npx -y @aaronalm19/roblox-mcp@latest
 * 
 * Or add to your MCP configuration:
 *   "robloxstudio": {
 *     "command": "npx",
 *     "args": ["-y", "@aaronalm19/roblox-mcp@latest"]
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'module';
import { createHttpServer, createHttpServerSharedState } from './http-server.js';
import { RobloxStudioTools } from './tools/index.js';
import { BridgeService } from './bridge-service.js';
import { getServerHostFallbacks, resolveServerHost } from './server-config.js';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json');

class RobloxStudioMCPServer {
  private server: Server;
  private tools: RobloxStudioTools;
  private bridge: BridgeService;

  constructor() {
    this.server = new Server(
      {
        name: 'robloxstudio-mcp',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.bridge = new BridgeService();
    this.tools = new RobloxStudioTools(this.bridge);
    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          // Instance Hierarchy Tools (NOT local filesystem - these operate on Roblox Studio instances)
          {
            name: 'get_file_tree',
            description: 'Return a Roblox instance tree from Studio, not your local filesystem.',
            inputSchema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Roblox instance path to start from using dot notation (e.g., "game.Workspace", "game.ServerScriptService"). Defaults to game root if empty.',
                  default: ''
                }
              }
            }
          },
          {
            name: 'search_files',
            description: 'Search Roblox instances by name, class, or script content.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query - instance name, class type (e.g., "Script", "Part"), or Lua code pattern'
                },
                searchType: {
                  type: 'string',
                  enum: ['name', 'type', 'content'],
                  description: 'Type of search: "name" for instance names, "type" for class names, "content" for script source code',
                  default: 'name'
                }
              },
              required: ['query']
            }
          },
          // Studio Context Tools
          {
            name: 'get_place_info',
            description: 'Get place ID, name, and game settings',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'get_runtime_state',
            description: 'Get MCP runtime state including write queue and bridge telemetry.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'list_studio_sessions',
            description: 'List active Studio plugin sessions known to the bridge (use these IDs for cross-session copy).',
            inputSchema: {
              type: 'object',
              properties: {
                maxAgeMs: {
                  type: 'number',
                  description: 'Only include sessions seen within this age window (milliseconds).',
                  default: 60000
                }
              }
            }
          },
          {
            name: 'get_diagnostics',
            description: 'Return MCP/plugin readiness plus write, cache, and snapshot diagnostics.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'check_script_drift',
            description: 'Compare local files with Studio script source and ignore formatting-only drift by default.',
            inputSchema: {
              type: 'object',
              properties: {
                mappings: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      instancePath: { type: 'string' },
                      localFile: { type: 'string' }
                    },
                    required: ['instancePath', 'localFile']
                  }
                },
                normalizeLineEndings: {
                  type: 'boolean',
                  description: 'When true (default), compare canonical text and ignore formatting-only differences such as line endings, BOM, trailing whitespace, and trailing final newlines. Set false for raw byte comparison.',
                  default: true
                }
              },
              required: ['mappings']
            }
          },
          {
            name: 'lint_deprecated_apis',
            description: 'Scan local source files for known deprecated Roblox API usage (for example GetCollisionGroups).',
            inputSchema: {
              type: 'object',
              properties: {
                rootPath: {
                  type: 'string',
                  description: 'Root path to scan. Defaults to current working directory.'
                }
              }
            }
          },
          {
            name: 'get_services',
            description: 'Get available Roblox services and their children',
            inputSchema: {
              type: 'object',
              properties: {
                serviceName: {
                  type: 'string',
                  description: 'Optional specific service name to query'
                }
              }
            }
          },
          {
            name: 'search_objects',
            description: 'Find instances by name, class, or properties',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query'
                },
                searchType: {
                  type: 'string',
                  enum: ['name', 'class', 'property'],
                  description: 'Type of search to perform',
                  default: 'name'
                },
                propertyName: {
                  type: 'string',
                  description: 'Property name when searchType is "property"'
                }
              },
              required: ['query']
            }
          },
          // Property & Instance Tools
          {
            name: 'get_instance_properties',
            description: 'Get properties for one Roblox instance. Script Source is excluded unless includeSource=true.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path using dot notation (e.g., "game.Workspace.Part", "game.ServerScriptService.MainScript", "game.ReplicatedStorage.ModuleScript")'
                },
                includeSource: {
                  type: 'boolean',
                  description: 'When true, include Source for LuaSourceContainer instances. Default is false to keep payloads smaller.',
                  default: false
                }
              },
              required: ['instancePath']
            }
          },
          {
            name: 'get_instance_children',
            description: 'Get child instances and their class types from a Roblox parent instance',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path using dot notation (e.g., "game.Workspace", "game.ServerScriptService")'
                }
              },
              required: ['instancePath']
            }
          },
          {
            name: 'export_instance_snapshot',
            description: 'Export an instance subtree into a server-side snapshot transfer (for low-token cross-session copy).',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Path to the source instance to export.'
                },
                includeScripts: {
                  type: 'boolean',
                  description: 'Include script source when true.',
                  default: true
                },
                maxDepth: {
                  type: 'number',
                  description: 'Max descendant depth to export.',
                  default: 30
                },
                sourceSessionId: {
                  type: 'string',
                  description: 'Optional source Studio session ID. If omitted, active/default routing is used.'
                }
              },
              required: ['instancePath']
            }
          },
          {
            name: 'import_instance_snapshot',
            description: 'Import a previously exported snapshot transfer into the current Studio session.',
            inputSchema: {
              type: 'object',
              properties: {
                transferId: {
                  type: 'string',
                  description: 'Transfer ID returned by export_instance_snapshot.'
                },
                targetParentPath: {
                  type: 'string',
                  description: 'Parent path where the snapshot root should be created.'
                },
                options: {
                  type: 'object',
                  properties: {
                    rootName: { type: 'string' },
                    conflictPolicy: {
                      type: 'string',
                      enum: ['rename', 'replace', 'fail'],
                      default: 'rename'
                    },
                    namePrefix: { type: 'string' },
                    nameSuffix: { type: 'string' },
                    scriptReplacements: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          find: { type: 'string' },
                          replace: { type: 'string' }
                        },
                        required: ['find', 'replace']
                      }
                    }
                  }
                },
                targetSessionId: {
                  type: 'string',
                  description: 'Optional target Studio session ID. If omitted, active/default routing is used.'
                }
              },
              required: ['transferId', 'targetParentPath']
            }
          },
          {
            name: 'copy_instance_snapshot',
            description: 'One-shot export+import copy (same active session). For cross-session, export then switch session then import.',
            inputSchema: {
              type: 'object',
              properties: {
                sourceInstancePath: { type: 'string' },
                targetParentPath: { type: 'string' },
                options: {
                  type: 'object',
                  properties: {
                    includeScripts: { type: 'boolean', default: true },
                    maxDepth: { type: 'number', default: 30 },
                    sourceSessionId: { type: 'string' },
                    targetSessionId: { type: 'string' },
                    rootName: { type: 'string' },
                    conflictPolicy: {
                      type: 'string',
                      enum: ['rename', 'replace', 'fail'],
                      default: 'rename'
                    },
                    namePrefix: { type: 'string' },
                    nameSuffix: { type: 'string' },
                    scriptReplacements: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          find: { type: 'string' },
                          replace: { type: 'string' }
                        },
                        required: ['find', 'replace']
                      }
                    }
                  }
                }
              },
              required: ['sourceInstancePath', 'targetParentPath']
            }
          },
          {
            name: 'copy_instance_cross_session',
            description: 'One-shot export from sourceSessionId and import into targetSessionId.',
            inputSchema: {
              type: 'object',
              properties: {
                sourceSessionId: { type: 'string' },
                targetSessionId: { type: 'string' },
                sourceInstancePath: { type: 'string' },
                targetParentPath: { type: 'string' },
                options: {
                  type: 'object',
                  properties: {
                    includeScripts: { type: 'boolean', default: true },
                    maxDepth: { type: 'number', default: 30 },
                    rootName: { type: 'string' },
                    conflictPolicy: {
                      type: 'string',
                      enum: ['rename', 'replace', 'fail'],
                      default: 'rename'
                    },
                    namePrefix: { type: 'string' },
                    nameSuffix: { type: 'string' },
                    scriptReplacements: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          find: { type: 'string' },
                          replace: { type: 'string' }
                        },
                        required: ['find', 'replace']
                      }
                    }
                  }
                }
              },
              required: ['sourceSessionId', 'targetSessionId', 'sourceInstancePath', 'targetParentPath']
            }
          },
          {
            name: 'list_instance_snapshot_transfers',
            description: 'List in-memory snapshot transfers available for import.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'delete_instance_snapshot_transfer',
            description: 'Delete one in-memory snapshot transfer after import.',
            inputSchema: {
              type: 'object',
              properties: {
                transferId: { type: 'string' }
              },
              required: ['transferId']
            }
          },
          {
            name: 'search_by_property',
            description: 'Find objects with specific property values',
            inputSchema: {
              type: 'object',
              properties: {
                propertyName: {
                  type: 'string',
                  description: 'Name of the property to search'
                },
                propertyValue: {
                  type: 'string',
                  description: 'Value to search for'
                }
              },
              required: ['propertyName', 'propertyValue']
            }
          },
          {
            name: 'get_class_info',
            description: 'Get available properties/methods for Roblox classes',
            inputSchema: {
              type: 'object',
              properties: {
                className: {
                  type: 'string',
                  description: 'Roblox class name'
                }
              },
              required: ['className']
            }
          },
          // Project Tools
          {
            name: 'get_project_structure',
            description: 'Browse project hierarchy. Prefer structure-map tools first and expand only the paths you need.',
            inputSchema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Optional path to start from (defaults to workspace root)',
                  default: ''
                },
                maxDepth: {
                  type: 'number',
                  description: 'Maximum depth to traverse. Keep this small unless you need a specific deep branch.',
                  default: 3
                },
                scriptsOnly: {
                  type: 'boolean',
                  description: 'Show only scripts and script containers',
                  default: false
                }
              }
            }
          },
          {
            name: 'get_structure_map_summary',
            description: 'Get the cached top-level structure summary for map-first discovery.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'query_structure_map',
            description: 'Query the cached structure map by path, class, subsystem, or name.',
            inputSchema: {
              type: 'object',
              properties: {
                filters: {
                  type: 'object',
                  properties: {
                    pathPrefix: { type: 'string' },
                    className: { type: 'string' },
                    hasSource: { type: 'boolean' },
                    scriptType: { type: 'string' },
                    subsystem: { type: 'string' },
                    nameQuery: { type: 'string' },
                    limit: { type: 'number' }
                  }
                },
                mode: {
                  type: 'string',
                  enum: ['compact', 'standard', 'verbose'],
                  default: 'compact'
                }
              }
            }
          },
          {
            name: 'refresh_structure_map',
            description: 'Rebuild the structure map from Studio and persist the cache.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'get_script_inventory',
            description: 'List cached script nodes with compact or verbose summary metadata.',
            inputSchema: {
              type: 'object',
              properties: {
                mode: {
                  type: 'string',
                  enum: ['compact', 'standard', 'verbose'],
                  default: 'compact'
                }
              }
            }
          },
          {
            name: 'explain_script_cached',
            description: 'Return a cached script summary and refresh it only when the source hash changed.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path to the script'
                }
              },
              required: ['instancePath']
            }
          },
          {
            name: 'get_subsystem_summary',
            description: 'Summarize one subsystem from cached structure and script summaries.',
            inputSchema: {
              type: 'object',
              properties: {
                subsystem: {
                  type: 'string',
                  description: 'Subsystem name such as AI, UI, Inventory, Combat, or Tycoon'
                }
              },
              required: ['subsystem']
            }
          },
          {
            name: 'analyze_project_architecture',
            description: 'AI-first architecture report built from cached structure-map and script summary data.',
            inputSchema: {
              type: 'object',
              properties: {
                subsystem: {
                  type: 'string',
                  description: 'Optional subsystem scope such as AI, UI, Inventory, Combat, or Tycoon'
                },
                pathPrefix: {
                  type: 'string',
                  description: 'Optional path substring to narrow the report to one branch'
                },
                scriptType: {
                  type: 'string',
                  description: 'Optional script type filter such as ModuleScript, Script, or LocalScript'
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of scripts to analyze from the cached scope',
                  default: 25
                },
                includeDependencies: {
                  type: 'boolean',
                  description: 'Echo dependency context in the architecture report.',
                  default: false
                }
              }
            }
          },
          {
            name: 'analyze_code_quality',
            description: 'AI-first code quality report with severity-ranked findings and refactor hints.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePaths: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional explicit script paths to analyze'
                },
                subsystem: {
                  type: 'string',
                  description: 'Optional subsystem scope'
                },
                pathPrefix: {
                  type: 'string',
                  description: 'Optional path substring scope'
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of scripts to read and score',
                  default: 10
                },
                includeSourceHints: {
                  type: 'boolean',
                  description: 'When true, include small evidence hints from source-derived findings.',
                  default: false
                }
              }
            }
          },
          // Property Modification Tools
          {
            name: 'set_property',
            description: 'Set a property on any Roblox instance',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Path to the instance (e.g., "game.Workspace.Part")'
                },
                propertyName: {
                  type: 'string',
                  description: 'Name of the property to set'
                },
                propertyValue: {
                  description: 'Value to set the property to (any type)'
                }
              },
              required: ['instancePath', 'propertyName', 'propertyValue']
            }
          },
          {
            name: 'mass_set_property',
            description: 'Set the same property on multiple instances at once',
            inputSchema: {
              type: 'object',
              properties: {
                paths: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of instance paths to modify'
                },
                propertyName: {
                  type: 'string',
                  description: 'Name of the property to set'
                },
                propertyValue: {
                  description: 'Value to set the property to (any type)'
                }
              },
              required: ['paths', 'propertyName', 'propertyValue']
            }
          },
          {
            name: 'mass_get_property',
            description: 'Get the same property from multiple instances at once',
            inputSchema: {
              type: 'object',
              properties: {
                paths: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of instance paths to read from'
                },
                propertyName: {
                  type: 'string',
                  description: 'Name of the property to get'
                }
              },
              required: ['paths', 'propertyName']
            }
          },
          // Object Creation/Deletion Tools
          {
            name: 'create_object',
            description: 'Create a new Roblox object instance (basic, without properties)',
            inputSchema: {
              type: 'object',
              properties: {
                className: {
                  type: 'string',
                  description: 'Roblox class name (e.g., "Part", "Script", "Folder")'
                },
                parent: {
                  type: 'string',
                  description: 'Path to the parent instance (e.g., "game.Workspace")'
                },
                name: {
                  type: 'string',
                  description: 'Optional name for the new object'
                }
              },
              required: ['className', 'parent']
            }
          },
          {
            name: 'create_object_with_properties',
            description: 'Create a new Roblox object instance with initial properties',
            inputSchema: {
              type: 'object',
              properties: {
                className: {
                  type: 'string',
                  description: 'Roblox class name (e.g., "Part", "Script", "Folder")'
                },
                parent: {
                  type: 'string',
                  description: 'Path to the parent instance (e.g., "game.Workspace")'
                },
                name: {
                  type: 'string',
                  description: 'Optional name for the new object'
                },
                properties: {
                  type: 'object',
                  description: 'Properties to set on creation'
                }
              },
              required: ['className', 'parent']
            }
          },
          {
            name: 'mass_create_objects',
            description: 'Create multiple objects at once (basic, without properties)',
            inputSchema: {
              type: 'object',
              properties: {
                objects: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      className: {
                        type: 'string',
                        description: 'Roblox class name'
                      },
                      parent: {
                        type: 'string',
                        description: 'Path to the parent instance'
                      },
                      name: {
                        type: 'string',
                        description: 'Optional name for the object'
                      }
                    },
                    required: ['className', 'parent']
                  },
                  description: 'Array of objects to create'
                }
              },
              required: ['objects']
            }
          },
          {
            name: 'mass_create_objects_with_properties',
            description: 'Create multiple objects at once with initial properties',
            inputSchema: {
              type: 'object',
              properties: {
                objects: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      className: {
                        type: 'string',
                        description: 'Roblox class name'
                      },
                      parent: {
                        type: 'string',
                        description: 'Path to the parent instance'
                      },
                      name: {
                        type: 'string',
                        description: 'Optional name for the object'
                      },
                      properties: {
                        type: 'object',
                        description: 'Properties to set on creation'
                      }
                    },
                    required: ['className', 'parent']
                  },
                  description: 'Array of objects to create with properties'
                }
              },
              required: ['objects']
            }
          },
          {
            name: 'delete_object',
            description: 'Delete a Roblox object instance',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Path to the instance to delete'
                }
              },
              required: ['instancePath']
            }
          },
          // Smart Duplication Tools
          {
            name: 'smart_duplicate',
            description: 'Smart duplication with automatic naming, positioning, and property variations',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Path to the instance to duplicate'
                },
                count: {
                  type: 'number',
                  description: 'Number of duplicates to create'
                },
                options: {
                  type: 'object',
                  properties: {
                    namePattern: {
                      type: 'string',
                      description: 'Name pattern with {n} placeholder (e.g., "Button{n}")'
                    },
                    positionOffset: {
                      type: 'array',
                      items: { type: 'number' },
                      minItems: 3,
                      maxItems: 3,
                      description: 'X, Y, Z offset per duplicate'
                    },
                    rotationOffset: {
                      type: 'array',
                      items: { type: 'number' },
                      minItems: 3,
                      maxItems: 3,
                      description: 'X, Y, Z rotation offset per duplicate'
                    },
                    scaleOffset: {
                      type: 'array',
                      items: { type: 'number' },
                      minItems: 3,
                      maxItems: 3,
                      description: 'X, Y, Z scale multiplier per duplicate'
                    },
                    propertyVariations: {
                      type: 'object',
                      description: 'Property name to array of values'
                    },
                    targetParents: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Different parent for each duplicate'
                    }
                  }
                }
              },
              required: ['instancePath', 'count']
            }
          },
          {
            name: 'mass_duplicate',
            description: 'Perform multiple smart duplications at once',
            inputSchema: {
              type: 'object',
              properties: {
                duplications: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      instancePath: {
                        type: 'string',
                        description: 'Path to the instance to duplicate'
                      },
                      count: {
                        type: 'number',
                        description: 'Number of duplicates to create'
                      },
                      options: {
                        type: 'object',
                        properties: {
                          namePattern: {
                            type: 'string',
                            description: 'Name pattern with {n} placeholder'
                          },
                          positionOffset: {
                            type: 'array',
                            items: { type: 'number' },
                            minItems: 3,
                            maxItems: 3,
                            description: 'X, Y, Z offset per duplicate'
                          },
                          rotationOffset: {
                            type: 'array',
                            items: { type: 'number' },
                            minItems: 3,
                            maxItems: 3,
                            description: 'X, Y, Z rotation offset per duplicate'
                          },
                          scaleOffset: {
                            type: 'array',
                            items: { type: 'number' },
                            minItems: 3,
                            maxItems: 3,
                            description: 'X, Y, Z scale multiplier per duplicate'
                          },
                          propertyVariations: {
                            type: 'object',
                            description: 'Property name to array of values'
                          },
                          targetParents: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Different parent for each duplicate'
                          }
                        }
                      }
                    },
                    required: ['instancePath', 'count']
                  },
                  description: 'Array of duplication operations'
                }
              },
              required: ['duplications']
            }
          },
          // Calculated Property Tools
          {
            name: 'set_calculated_property',
            description: 'Set properties using mathematical formulas and variables',
            inputSchema: {
              type: 'object',
              properties: {
                paths: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of instance paths to modify'
                },
                propertyName: {
                  type: 'string',
                  description: 'Name of the property to set'
                },
                formula: {
                  type: 'string',
                  description: 'Mathematical formula (e.g., "Position.magnitude * 2", "index * 50")'
                },
                variables: {
                  type: 'object',
                  description: 'Additional variables for the formula'
                }
              },
              required: ['paths', 'propertyName', 'formula']
            }
          },
          // Relative Property Tools
          {
            name: 'set_relative_property',
            description: 'Modify properties relative to their current values',
            inputSchema: {
              type: 'object',
              properties: {
                paths: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of instance paths to modify'
                },
                propertyName: {
                  type: 'string',
                  description: 'Name of the property to modify'
                },
                operation: {
                  type: 'string',
                  enum: ['add', 'multiply', 'divide', 'subtract', 'power'],
                  description: 'Mathematical operation to perform'
                },
                value: {
                  description: 'Value to use in the operation'
                },
                component: {
                  type: 'string',
                  enum: ['X', 'Y', 'Z', 'XScale', 'XOffset', 'YScale', 'YOffset'],
                  description: 'For Vector3: X, Y, Z. For UDim2: XScale, XOffset, YScale, YOffset (value must be a number)'
                }
              },
              required: ['paths', 'propertyName', 'operation', 'value']
            }
          },
          // Script Management Tools (for Roblox Studio scripts - NOT local files)
          {
            name: 'get_script_source',
            description: 'Read Roblox script source. Use line ranges for targeted reads when possible.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path to the script using dot notation (e.g., "game.ServerScriptService.MainScript", "game.StarterPlayer.StarterPlayerScripts.LocalScript")'
                },
                startLine: {
                  type: 'number',
                  description: 'Optional: Start line number (1-indexed). Use for reading specific sections of large scripts.'
                },
                endLine: {
                  type: 'number',
                  description: 'Optional: End line number (inclusive). Use for reading specific sections of large scripts.'
                }
              },
              required: ['instancePath']
            }
          },
          {
            name: 'get_script_snapshot',
            description: 'Read script source plus a deterministic SHA-256 source hash.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path to the script (e.g., "game.ServerScriptService.MainScript")'
                },
                startLine: {
                  type: 'number',
                  description: 'Optional: Start line number (1-indexed).'
                },
                endLine: {
                  type: 'number',
                  description: 'Optional: End line number (inclusive).'
                }
              },
              required: ['instancePath']
            }
          },
          {
            name: 'set_script_source',
            description: 'Replace full script source. Use chunked upload tools for very large rewrites.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path to the script (e.g., "game.ServerScriptService.MainScript")'
                },
                source: {
                  type: 'string',
                  description: 'New source code for the script'
                },
                expectedHash: {
                  type: 'string',
                  description: 'Optional optimistic lock hash from get_script_snapshot. Write will fail if source changed.'
                }
              },
              required: ['instancePath', 'source']
            }
          },
          {
            name: 'begin_script_source_upload',
            description: 'Start a chunked upload session for large script rewrites.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path to the script'
                },
                expectedHash: {
                  type: 'string',
                  description: 'Optional optimistic lock hash from get_script_snapshot'
                },
                mode: {
                  type: 'string',
                  enum: ['set', 'apply_and_verify'],
                  description: 'Commit mode for the uploaded source',
                  default: 'set'
                }
              },
              required: ['instancePath']
            }
          },
          {
            name: 'append_script_source_upload_chunk',
            description: 'Append one chunk of source text to a chunked upload session.',
            inputSchema: {
              type: 'object',
              properties: {
                uploadId: {
                  type: 'string',
                  description: 'Upload session id from begin_script_source_upload'
                },
                chunk: {
                  type: 'string',
                  description: 'Next source chunk'
                },
                chunkIndex: {
                  type: 'number',
                  description: 'Optional zero-based chunk index for ordering validation'
                }
              },
              required: ['uploadId', 'chunk']
            }
          },
          {
            name: 'commit_script_source_upload',
            description: 'Commit a chunked script upload session to Studio after all chunks are appended.',
            inputSchema: {
              type: 'object',
              properties: {
                uploadId: {
                  type: 'string',
                  description: 'Upload session id from begin_script_source_upload'
                },
                verifyNeedle: {
                  type: 'string',
                  description: 'Optional required text when mode is apply_and_verify'
                },
                rollbackOnFailure: {
                  type: 'boolean',
                  default: true
                },
                preferFast: {
                  type: 'boolean',
                  description: 'Prefer fast write path when mode is apply_and_verify',
                  default: false
                }
              },
              required: ['uploadId']
            }
          },
          {
            name: 'cancel_script_source_upload',
            description: 'Discard a chunked script upload session without writing anything to Studio.',
            inputSchema: {
              type: 'object',
              properties: {
                uploadId: {
                  type: 'string',
                  description: 'Upload session id from begin_script_source_upload'
                }
              },
              required: ['uploadId']
            }
          },
          {
            name: 'set_script_source_checked',
            description: 'Replace script source only if expectedHash matches the current script hash.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path to the script'
                },
                source: {
                  type: 'string',
                  description: 'New source code for the script'
                },
                expectedHash: {
                  type: 'string',
                  description: 'Required source hash from get_script_snapshot'
                }
              },
              required: ['instancePath', 'source', 'expectedHash']
            }
          },
          {
            name: 'set_script_source_fast',
            description: 'Fast full-source write with safe fallback when the fast endpoint is unavailable.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path to the script'
                },
                source: {
                  type: 'string',
                  description: 'New source code for the script'
                },
                verify: {
                  type: 'boolean',
                  description: 'Verify source after write (recommended true)',
                  default: true
                }
              },
              required: ['instancePath', 'source']
            }
          },
          {
            name: 'set_script_source_fast_gzip',
            description: 'Fast full-source write using gzip+base64 transport to reduce large payload transfer overhead.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path to the script'
                },
                sourceGzipBase64: {
                  type: 'string',
                  description: 'Gzip-compressed source as base64 string'
                },
                verify: {
                  type: 'boolean',
                  description: 'Verify source after write',
                  default: true
                }
              },
              required: ['instancePath', 'sourceGzipBase64']
            }
          },
          {
            name: 'create_script_snapshot',
            description: 'Create an in-memory rollback snapshot for a script from current Studio source.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox script path'
                },
                label: {
                  type: 'string',
                  description: 'Optional snapshot label'
                }
              },
              required: ['instancePath']
            }
          },
          {
            name: 'list_script_snapshots',
            description: 'List in-memory rollback snapshots created in this MCP session.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Optional script path filter'
                }
              }
            }
          },
          {
            name: 'rollback_script_snapshot',
            description: 'Restore script source from an in-memory snapshot id.',
            inputSchema: {
              type: 'object',
              properties: {
                snapshotId: {
                  type: 'string',
                  description: 'Snapshot id returned by create_script_snapshot'
                },
                verify: {
                  type: 'boolean',
                  default: true
                }
              },
              required: ['snapshotId']
            }
          },
          {
            name: 'apply_and_verify_script_source',
            description: 'Apply full script source, verify it, and rollback on failure.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox script path'
                },
                source: {
                  type: 'string',
                  description: 'New full source'
                },
                expectedHash: {
                  type: 'string',
                  description: 'Optional current hash guard'
                },
                verifyNeedle: {
                  type: 'string',
                  description: 'Optional required text that must exist after write'
                },
                rollbackOnFailure: {
                  type: 'boolean',
                  default: true
                },
                preferFast: {
                  type: 'boolean',
                  description: 'Prefer direct fast write path'
                }
              },
              required: ['instancePath', 'source']
            }
          },
          // Partial Script Editing Tools - use "numberedSource" from get_script_source to identify correct line numbers
          {
            name: 'edit_script_lines',
            description: 'Replace a line range without rewriting the whole script.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path to the script (e.g., "game.ServerScriptService.MainScript")'
                },
                startLine: {
                  type: 'number',
                  description: 'First line to replace (1-indexed). Get this from the "numberedSource" field.'
                },
                endLine: {
                  type: 'number',
                  description: 'Last line to replace (inclusive). Get this from the "numberedSource" field.'
                },
                newContent: {
                  type: 'string',
                  description: 'New content to replace the specified lines (can be multiple lines separated by newlines)'
                }
              },
              required: ['instancePath', 'startLine', 'endLine', 'newContent']
            }
          },
          {
            name: 'insert_script_lines',
            description: 'Insert lines into a Roblox script at a specific position.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path to the script (e.g., "game.ServerScriptService.MainScript")'
                },
                afterLine: {
                  type: 'number',
                  description: 'Insert after this line number (0 = insert at very beginning, 1 = after first line). Get line numbers from "numberedSource".',
                  default: 0
                },
                newContent: {
                  type: 'string',
                  description: 'Content to insert (can be multiple lines separated by newlines)'
                }
              },
              required: ['instancePath', 'newContent']
            }
          },
          {
            name: 'delete_script_lines',
            description: 'Delete a line range from a Roblox script.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path to the script (e.g., "game.ServerScriptService.MainScript")'
                },
                startLine: {
                  type: 'number',
                  description: 'First line to delete (1-indexed). Get this from the "numberedSource" field.'
                },
                endLine: {
                  type: 'number',
                  description: 'Last line to delete (inclusive). Get this from the "numberedSource" field.'
                }
              },
              required: ['instancePath', 'startLine', 'endLine']
            }
          },
          {
            name: 'batch_script_edits',
            description: 'Apply multiple line edits atomically with optional rollback and hash checks.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox script path'
                },
                operations: {
                  type: 'array',
                  description: 'Array of edit operations',
                  items: {
                    type: 'object',
                    properties: {
                      op: {
                        type: 'string',
                        enum: ['replace', 'insert', 'delete']
                      },
                      startLine: {
                        type: 'number'
                      },
                      endLine: {
                        type: 'number'
                      },
                      afterLine: {
                        type: 'number'
                      },
                      newContent: {
                        type: 'string'
                      }
                    },
                    required: ['op']
                  }
                },
                expectedHash: {
                  type: 'string',
                  description: 'Optional source hash from get_script_snapshot'
                },
                rollbackOnFailure: {
                  type: 'boolean',
                  description: 'If true, restore original source when any edit fails',
                  default: true
                },
                fastMode: {
                  type: 'boolean',
                  description: 'If true, skip post-write hash verification for maximum speed',
                  default: false
                }
              },
              required: ['instancePath', 'operations']
            }
          },
          {
            name: 'replace_script_function',
            description: 'Replace one Luau function block by function name, without manual line math.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox script path'
                },
                functionName: {
                  type: 'string',
                  description: 'Exact Luau function name, for example `foo`, `M.foo`, or `Class:method`.'
                },
                newFunctionContent: {
                  type: 'string',
                  description: 'Full replacement function block including `function ...` and closing `end`.'
                },
                expectedHash: {
                  type: 'string',
                  description: 'Optional source hash guard.'
                }
              },
              required: ['instancePath', 'functionName', 'newFunctionContent']
            }
          },
          {
            name: 'get_luau_diagnostics',
            description: 'Run Luau static diagnostics for one or more Studio scripts through luau-lsp when available.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePaths: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Studio script paths to analyze.'
                },
                includeSourceHints: {
                  type: 'boolean',
                  description: 'Include raw diagnostic lines from analyzer output.',
                  default: false
                }
              },
              required: ['instancePaths']
            }
          },
          // Attribute Tools (for Roblox instance attributes)
          {
            name: 'get_attribute',
            description: 'Get a single attribute value from a Roblox instance',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path using dot notation (e.g., "game.Workspace.Part", "game.ServerStorage.DataStore")'
                },
                attributeName: {
                  type: 'string',
                  description: 'Name of the attribute to get'
                }
              },
              required: ['instancePath', 'attributeName']
            }
          },
          {
            name: 'set_attribute',
            description: 'Set an attribute value on a Roblox instance. Supports string, number, boolean, Vector3, Color3, UDim2, and BrickColor.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path using dot notation (e.g., "game.Workspace.Part")'
                },
                attributeName: {
                  type: 'string',
                  description: 'Name of the attribute to set'
                },
                attributeValue: {
                  description: 'Value to set. For Vector3: {X, Y, Z}, Color3: {R, G, B}, UDim2: {X: {Scale, Offset}, Y: {Scale, Offset}}'
                },
                valueType: {
                  type: 'string',
                  description: 'Optional type hint: "Vector3", "Color3", "UDim2", "BrickColor"'
                }
              },
              required: ['instancePath', 'attributeName', 'attributeValue']
            }
          },
          {
            name: 'get_attributes',
            description: 'Get all attributes on a Roblox instance',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path using dot notation (e.g., "game.Workspace.Part")'
                }
              },
              required: ['instancePath']
            }
          },
          {
            name: 'delete_attribute',
            description: 'Delete an attribute from a Roblox instance',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path using dot notation (e.g., "game.Workspace.Part")'
                },
                attributeName: {
                  type: 'string',
                  description: 'Name of the attribute to delete'
                }
              },
              required: ['instancePath', 'attributeName']
            }
          },
          // Tag Tools (CollectionService) - for Roblox instance tags
          {
            name: 'get_tags',
            description: 'Get all CollectionService tags on a Roblox instance',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path using dot notation (e.g., "game.Workspace.Part")'
                }
              },
              required: ['instancePath']
            }
          },
          {
            name: 'add_tag',
            description: 'Add a CollectionService tag to a Roblox instance',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path using dot notation (e.g., "game.Workspace.Part")'
                },
                tagName: {
                  type: 'string',
                  description: 'Name of the tag to add'
                }
              },
              required: ['instancePath', 'tagName']
            }
          },
          {
            name: 'remove_tag',
            description: 'Remove a CollectionService tag from a Roblox instance',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path using dot notation (e.g., "game.Workspace.Part")'
                },
                tagName: {
                  type: 'string',
                  description: 'Name of the tag to remove'
                }
              },
              required: ['instancePath', 'tagName']
            }
          },
          {
            name: 'get_tagged',
            description: 'Get all instances with a specific tag',
            inputSchema: {
              type: 'object',
              properties: {
                tagName: {
                  type: 'string',
                  description: 'Name of the tag to search for'
                }
              },
              required: ['tagName']
            }
          },
          {
            name: 'get_selection',
            description: 'Get all currently selected objects',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'cancel_pending_writes',
            description: 'Cancel queued write operations that have not started yet.',
            inputSchema: {
              type: 'object',
              properties: {
                prefix: {
                  type: 'string',
                  description: 'Optional operation label prefix filter.'
                }
              }
            }
          },
          {
            name: 'execute_luau',
            description: 'Execute Luau in the Studio plugin context and return the result.',
            inputSchema: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  description: 'Luau code to execute. Can use print() for output. The return value is captured.'
                }
              },
              required: ['code']
            }
          },
          {
            name: 'start_playtest',
            description: 'Start a play test session in Roblox Studio and begin capturing output.',
            inputSchema: {
              type: 'object',
              properties: {
                mode: {
                  type: 'string',
                  enum: ['play', 'run'],
                  description: '"play" for Play Solo mode, "run" for Run mode'
                }
              },
              required: ['mode']
            }
          },
          {
            name: 'stop_playtest',
            description: 'Stop the running play test session and return captured output.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'get_playtest_output',
            description: 'Poll output from the currently running play test without stopping it.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          // AI Player Control Tools - Control the player character during playtest
          {
            name: 'ai_control_player',
            description: 'Control the player character (move, jump, camera) during an active playtest. AI uses this to play the game and test gameplay.',
            inputSchema: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['move_forward', 'move_backward', 'move_left', 'move_right', 'jump', 'crouch', 'run', 'walk', 'look_up', 'look_down', 'look_left', 'look_right', 'stop'],
                  description: 'Player action to perform'
                },
                duration: {
                  type: 'number',
                  description: 'Duration in seconds for the action (default 0.1)'
                },
                speed: {
                  type: 'number',
                  description: 'Speed multiplier (0.1 to 10, default 1.0)'
                }
              },
              required: ['action']
            }
          },
          {
            name: 'ai_get_player_state',
            description: 'Get current player state - position, rotation, health, inventory, nearby objects.',
            inputSchema: {
              type: 'object',
              properties: {
                includeNearby: {
                  type: 'boolean',
                  description: 'Include nearby objects within radius',
                  default: true
                },
                nearbyRadius: {
                  type: 'number',
                  description: 'Radius for nearby objects check (default 50 studs)',
                  default: 50
                }
              }
            }
          },
          {
            name: 'ai_interact_with_object',
            description: 'Interact with a game object (click, touch, proximity trigger) during playtest.',
            inputSchema: {
              type: 'object',
              properties: {
                objectPath: {
                  type: 'string',
                  description: 'Roblox instance path to the object'
                },
                action: {
                  type: 'string',
                  enum: ['click', 'touch', 'activate', 'proximity', 'hover'],
                  description: 'Type of interaction'
                },
                playerIndex: {
                  type: 'number',
                  description: 'Player index for multiplayer (default 1)',
                  default: 1
                }
              },
              required: ['objectPath', 'action']
            }
          },
          {
            name: 'ai_teleport_player',
            description: 'Teleport the player to a specific position in the game world.',
            inputSchema: {
              type: 'object',
              properties: {
                position: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    z: { type: 'number' }
                  },
                  required: ['x', 'y', 'z']
                },
                rotation: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    z: { type: 'number' }
                  },
                  description: 'Optional rotation (Euler angles in degrees)'
                },
                playerIndex: {
                  type: 'number',
                  description: 'Player index (default 1)',
                  default: 1
                }
              },
              required: ['position']
            }
          },
          // Game State & Debugging Tools
          {
            name: 'get_game_state',
            description: 'Get comprehensive game state during playtest - players, NPCs, projectiles, physics state.',
            inputSchema: {
              type: 'object',
              properties: {
                scope: {
                  type: 'string',
                  enum: ['all', 'players', 'npcs', 'projectiles', 'physics'],
                  description: 'What to query',
                  default: 'all'
                },
                maxResults: {
                  type: 'number',
                  description: 'Maximum results to return',
                  default: 50
                }
              }
            }
          },
          {
            name: 'capture_debug_logs',
            description: 'Capture recent debug output, warnings, and errors from the game.',
            inputSchema: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['all', 'errors', 'warnings', 'print', 'custom'],
                  description: 'Type of logs to capture',
                  default: 'all'
                },
                maxLines: {
                  type: 'number',
                  description: 'Maximum number of log lines to capture',
                  default: 100
                },
                sinceTimestamp: {
                  type: 'number',
                  description: 'Only capture logs after this timestamp (optional)'
                }
              }
            }
          },
          {
            name: 'open_debug_log_stream',
            description: 'Open a server-side cursor for incremental debug log polling.',
            inputSchema: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['all', 'errors', 'warnings', 'print', 'custom'],
                  description: 'Type of logs to stream',
                  default: 'all'
                }
              }
            }
          },
          {
            name: 'poll_debug_log_stream',
            description: 'Poll only new log entries for a previously opened debug log cursor.',
            inputSchema: {
              type: 'object',
              properties: {
                cursorId: {
                  type: 'string',
                  description: 'Cursor ID returned by open_debug_log_stream.'
                },
                maxLines: {
                  type: 'number',
                  description: 'Maximum number of new log lines to return.',
                  default: 100
                }
              },
              required: ['cursorId']
            }
          },
          {
            name: 'close_debug_log_stream',
            description: 'Close a debug log cursor when no longer needed.',
            inputSchema: {
              type: 'object',
              properties: {
                cursorId: {
                  type: 'string',
                  description: 'Cursor ID returned by open_debug_log_stream.'
                }
              },
              required: ['cursorId']
            }
          },
          {
            name: 'get_runtime_errors',
            description: 'Get current runtime errors from scripts during playtest.',
            inputSchema: {
              type: 'object',
              properties: {
                clearAfter: {
                  type: 'boolean',
                  description: 'Clear errors after reading',
                  default: false
                }
              }
            }
          },
          {
            name: 'execute_test_sequence',
            description: 'Execute a sequence of game actions for testing - movement, interactions, waits.',
            inputSchema: {
              type: 'object',
              properties: {
                steps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      action: {
                        type: 'string',
                        enum: ['wait', 'move', 'jump', 'click', 'touch', 'teleport', 'set_property', 'get_property', 'execute_luau']
                      },
                      duration: { type: 'number' },
                      position: {
                        type: 'object',
                        properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }
                      },
                      target: { type: 'string' },
                      propertyName: { type: 'string' },
                      propertyValue: {},
                      code: { type: 'string' }
                    }
                  },
                  description: 'Array of test steps to execute'
                },
                stopOnError: {
                  type: 'boolean',
                  description: 'Stop sequence if any step fails',
                  default: true
                }
              },
              required: ['steps']
            }
          },
          {
            name: 'watch_property_changes',
            description: 'Monitor property changes on instances in real-time during playtest.',
            inputSchema: {
              type: 'object',
              properties: {
                instancePath: {
                  type: 'string',
                  description: 'Roblox instance path to watch'
                },
                properties: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Property names to monitor'
                },
                duration: {
                  type: 'number',
                  description: 'How long to watch (seconds, default 30)'
                }
              },
              required: ['instancePath', 'properties']
            }
          },
          {
            name: 'get_performance_metrics',
            description: 'Get performance metrics during playtest - FPS, memory, network, physics.',
            inputSchema: {
              type: 'object',
              properties: {
                category: {
                  type: 'string',
                  enum: ['all', 'fps', 'memory', 'network', 'physics', 'instances'],
                  description: 'Category of metrics to retrieve',
                  default: 'all'
                }
              }
            }
          },
          {
            name: 'capture_performance_snapshot',
            description: 'Capture multiple performance samples and return an aggregated summary.',
            inputSchema: {
              type: 'object',
              properties: {
                category: {
                  type: 'string',
                  enum: ['all', 'fps', 'memory', 'network', 'physics', 'instances'],
                  description: 'Category of metrics to retrieve',
                  default: 'all'
                },
                sampleCount: {
                  type: 'number',
                  description: 'How many samples to capture.',
                  default: 3
                },
                intervalMs: {
                  type: 'number',
                  description: 'Delay between samples in milliseconds.',
                  default: 250
                }
              }
            }
          },
          {
            name: 'inspect_terrain',
            description: 'Get terrain and physics information for navmesh/pathfinding.',
            inputSchema: {
              type: 'object',
              properties: {
                region: {
                  type: 'object',
                  properties: {
                    minX: { type: 'number' },
                    minY: { type: 'number' },
                    minZ: { type: 'number' },
                    maxX: { type: 'number' },
                    maxY: { type: 'number' },
                    maxZ: { type: 'number' }
                  },
                  description: 'Region to inspect'
                },
                includeNavmesh: {
                  type: 'boolean',
                  description: 'Include navmesh data if available'
                }
              }
            }
          },
          {
            name: 'get_network_stats',
            description: 'Get detailed network statistics for the current playtest session.',
            inputSchema: {
              type: 'object',
              properties: {
                includePlayers: {
                  type: 'boolean',
                  description: 'Include per-player statistics'
                }
              }
            }
          },
          {
            name: 'simulate_input',
            description: 'Simulate user input events (keypress, mouse, touch) for testing UI and interactions.',
            inputSchema: {
              type: 'object',
              properties: {
                inputType: {
                  type: 'string',
                  enum: ['keypress', 'keydown', 'keyup', 'mouse_click', 'mouse_move', 'mouse_down', 'mouse_up', 'touch_tap', 'touch_drag']
                },
                target: {
                  type: 'string',
                  description: 'Object path for UI clicks (optional)'
                },
                position: {
                  type: 'object',
                  properties: { x: { type: 'number' }, y: { type: 'number' } }
                },
                keyCode: {
                  type: 'string',
                  description: 'KeyCode for keyboard input (e.g., Enum.KeyCode.F)'
                }
              },
              required: ['inputType']
            }
          },
          {
            name: 'parse_ui_reference',
            description: 'Analyze a UI reference image and extract layout structure, colors, and elements for Roblox UI generation.',
            inputSchema: {
              type: 'object',
              properties: {
                imageData: {
                  type: 'string',
                  description: 'Image data as base64 string (with or without data URI prefix) or file path to image'
                },
                options: {
                  type: 'object',
                  properties: {
                    detectText: {
                      type: 'boolean',
                      description: 'Enable text element detection',
                      default: true
                    },
                    detectButtons: {
                      type: 'boolean',
                      description: 'Enable button element detection',
                      default: true
                    },
                    minElementSize: {
                      type: 'number',
                      description: 'Minimum element size in pixels to detect',
                      default: 20
                    },
                    colorClusterCount: {
                      type: 'number',
                      description: 'Number of dominant colors to extract',
                      default: 8
                    }
                  }
                }
              },
              required: ['imageData']
            }
          },
          {
            name: 'generate_ui',
            description: 'Generate Roblox UI from parsed image data. Creates rich UI elements with proper scaling, positioning, animations, and responsive behavior based on image-parser output.',
            inputSchema: {
              type: 'object',
              properties: {
                uiContainer: {
                  type: 'object',
                  description: 'UI container definition with type, name, and elements array'
                },
                scalingConfig: {
                  type: 'object',
                  description: 'Coordinate reference and scaling configuration',
                  properties: {
                    referenceWidth: { type: 'number' },
                    referenceHeight: { type: 'number' },
                    scaleMode: { type: 'string', enum: ['exact', 'proportional', 'responsive'] },
                    coordinateReference: {
                      type: 'object',
                      properties: {
                        anchorPoint: { type: 'string' },
                        offsetX: { type: 'number' },
                        offsetY: { type: 'number' },
                        parentReference: { type: 'string' }
                      }
                    }
                  }
                },
                metadata: {
                  type: 'object',
                  description: 'Optional metadata about the source image',
                  properties: {
                    sourceImageUrl: { type: 'string' },
                    parserVersion: { type: 'string' },
                    generationTimestamp: { type: 'number' }
                  }
                }
              },
              required: ['uiContainer']
            }
          },
          {
            name: 'parse_and_generate_ui',
            description: 'Parse a UI reference image and generate Roblox UI in one step. Combines parse_ui_reference and generate_ui for seamless workflow.',
            inputSchema: {
              type: 'object',
              properties: {
                imageData: {
                  type: 'string',
                  description: 'Image data as base64 string or file path'
                },
                options: {
                  type: 'object',
                  properties: {
                    detectText: { type: 'boolean' },
                    detectButtons: { type: 'boolean' },
                    minElementSize: { type: 'number' },
                    colorClusterCount: { type: 'number' },
                    scalingConfig: {
                      type: 'object',
                      description: 'Optional scaling configuration override'
                    }
                  }
                }
              },
              required: ['imageData']
            }
          },
          // Agent Management Tools
          {
            name: 'agent_chat',
            description: 'Send a message to an AI agent and get a response for direct AI communication from Studio.',
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'Message to send to the agent'
                },
                agentId: {
                  type: 'string',
                  description: 'Target agent ID (default: "default")'
                },
                threadId: {
                  type: 'string',
                  description: 'Thread ID for conversation continuity'
                },
                options: {
                  type: 'object',
                  properties: {
                    temperature: { type: 'number' },
                    maxTokens: { type: 'number' }
                  }
                }
              },
              required: ['message']
            }
          },
          {
            name: 'agent_status',
            description: 'Get status of all AI agents including tokens, latency, and request counts.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'agent_control',
            description: 'Control agent state (pause, resume, stop) for all or specific agents.',
            inputSchema: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['pause', 'resume', 'stop'],
                  description: 'Action to perform on the agent'
                },
                agentId: {
                  type: 'string',
                  description: 'Target agent ID (default: all agents)'
                }
              },
              required: ['action']
            }
          },
          {
            name: 'get_agent_threads',
            description: 'Get conversation threads for an agent including message count and status.',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: {
                  type: 'string',
                  description: 'Agent ID to get threads for'
                }
              }
            }
          },
          {
            name: 'get_agent_metrics',
            description: 'Get aggregated metrics for all agents: tokens, latency percentiles, lane stats.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          // ATO Agentic Tools
          {
            name: 'subscribe_file_tree',
            description: 'Subscribe to real-time file tree deltas via WebSocket. Deltas are broadcast when instances are created, modified, or deleted in Studio.',
            inputSchema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Optional root path to subscribe to (defaults to game root)',
                  default: 'game'
                }
              }
            }
          },
          {
            name: 'get_task_status',
            description: 'Get status of a specific task by ID.',
            inputSchema: {
              type: 'object',
              properties: {
                taskId: {
                  type: 'string',
                  description: 'Task ID returned by decompose_goal or task creation'
                }
              },
              required: ['taskId']
            }
          },
          {
            name: 'list_tasks',
            description: 'List all tasks or filter by goal/agent/status.',
            inputSchema: {
              type: 'object',
              properties: {
                goalId: {
                  type: 'string',
                  description: 'Filter by goal ID'
                },
                agentId: {
                  type: 'string',
                  description: 'Filter by agent ID'
                },
                status: {
                  type: 'string',
                  enum: ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'],
                  description: 'Filter by task status'
                }
              }
            }
          },
          {
            name: 'execute_direct_command',
            description: 'Execute a direct command from Studio UI without external chat. Returns taskId for progress tracking.',
            inputSchema: {
              type: 'object',
              properties: {
                command: {
                  type: 'string',
                  description: 'Command name from the direct commands list'
                },
                params: {
                  type: 'object',
                  description: 'Command parameters as key-value pairs'
                }
              },
              required: ['command']
            }
          },
          {
            name: 'cancel_task',
            description: 'Cancel a running or pending task by ID.',
            inputSchema: {
              type: 'object',
              properties: {
                taskId: {
                  type: 'string',
                  description: 'Task ID to cancel'
                }
              },
              required: ['taskId']
            }
          },
          {
            name: 'list_direct_commands',
            description: 'List all available direct commands that can be executed from Studio UI.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          // File System Tools
          case 'get_file_tree':
            return await this.tools.getFileTree((args as any)?.path || '');
          case 'search_files':
            return await this.tools.searchFiles((args as any)?.query as string, (args as any)?.searchType || 'name');
          
          // Studio Context Tools
          case 'get_place_info':
            return await this.tools.getPlaceInfo();
          case 'get_runtime_state':
            return await this.tools.getRuntimeState();
          case 'list_studio_sessions':
            return this.tools.listStudioSessions((args as any)?.maxAgeMs as number | undefined);
          case 'get_diagnostics':
            return await this.tools.getDiagnostics();
          case 'check_script_drift':
            return await this.tools.checkScriptDrift(
              (args as any)?.mappings as Array<{ instancePath: string; localFile: string }>,
              (args as any)?.normalizeLineEndings as boolean | undefined
            );
          case 'lint_deprecated_apis':
            return await this.tools.lintDeprecatedApis((args as any)?.rootPath as string | undefined);
          case 'get_services':
            return await this.tools.getServices((args as any)?.serviceName);
          case 'search_objects':
            return await this.tools.searchObjects((args as any)?.query as string, (args as any)?.searchType || 'name', (args as any)?.propertyName);
          
          // Property & Instance Tools
          case 'get_instance_properties':
            return await this.tools.getInstanceProperties(
              (args as any)?.instancePath as string,
              (args as any)?.includeSource as boolean | undefined
            );
          case 'get_instance_children':
            return await this.tools.getInstanceChildren((args as any)?.instancePath as string);
          case 'export_instance_snapshot':
            return await this.tools.exportInstanceSnapshot(
              (args as any)?.instancePath as string,
              {
                includeScripts: (args as any)?.includeScripts as boolean | undefined,
                maxDepth: (args as any)?.maxDepth as number | undefined,
              },
              (args as any)?.sourceSessionId as string | undefined
            );
          case 'import_instance_snapshot':
            return await this.tools.importInstanceSnapshot(
              (args as any)?.transferId as string,
              (args as any)?.targetParentPath as string,
              (args as any)?.options,
              (args as any)?.targetSessionId as string | undefined
            );
          case 'copy_instance_snapshot':
            return await this.tools.copyInstanceSnapshot(
              (args as any)?.sourceInstancePath as string,
              (args as any)?.targetParentPath as string,
              (args as any)?.options
            );
          case 'copy_instance_cross_session':
            return await this.tools.copyInstanceCrossSession(
              (args as any)?.sourceSessionId as string,
              (args as any)?.targetSessionId as string,
              (args as any)?.sourceInstancePath as string,
              (args as any)?.targetParentPath as string,
              (args as any)?.options
            );
          case 'list_instance_snapshot_transfers':
            return this.tools.listInstanceSnapshotTransfers();
          case 'delete_instance_snapshot_transfer':
            return this.tools.deleteInstanceSnapshotTransfer((args as any)?.transferId as string);
          case 'search_by_property':
            return await this.tools.searchByProperty((args as any)?.propertyName as string, (args as any)?.propertyValue as string);
          case 'get_class_info':
            return await this.tools.getClassInfo((args as any)?.className as string);
          
          // Project Tools
          case 'get_project_structure':
            return await this.tools.getProjectStructure((args as any)?.path, (args as any)?.maxDepth, (args as any)?.scriptsOnly);
          case 'get_structure_map_summary':
            return await this.tools.getStructureMapSummary();
          case 'query_structure_map':
            return await this.tools.queryStructureMap((args as any)?.filters, (args as any)?.mode);
          case 'refresh_structure_map':
            return await this.tools.refreshStructureMap();
          case 'get_script_inventory':
            return await this.tools.getScriptInventory((args as any)?.mode);
          case 'explain_script_cached':
            return await this.tools.explainScriptCached((args as any)?.instancePath as string);
          case 'get_subsystem_summary':
            return await this.tools.getSubsystemSummary((args as any)?.subsystem as string);
          case 'analyze_project_architecture':
            return await this.tools.analyzeProjectArchitecture({
              subsystem: (args as any)?.subsystem as string | undefined,
              pathPrefix: (args as any)?.pathPrefix as string | undefined,
              scriptType: (args as any)?.scriptType as string | undefined,
              limit: (args as any)?.limit as number | undefined,
              includeDependencies: (args as any)?.includeDependencies as boolean | undefined,
            });
          case 'analyze_code_quality':
            return await this.tools.analyzeCodeQuality({
              instancePaths: (args as any)?.instancePaths as string[] | undefined,
              subsystem: (args as any)?.subsystem as string | undefined,
              pathPrefix: (args as any)?.pathPrefix as string | undefined,
              limit: (args as any)?.limit as number | undefined,
              includeSourceHints: (args as any)?.includeSourceHints as boolean | undefined,
            });
          
          // Property Modification Tools
          case 'set_property':
            return await this.tools.setProperty((args as any)?.instancePath as string, (args as any)?.propertyName as string, (args as any)?.propertyValue);
          
          // Mass Property Tools
          case 'mass_set_property':
            return await this.tools.massSetProperty((args as any)?.paths as string[], (args as any)?.propertyName as string, (args as any)?.propertyValue);
          case 'mass_get_property':
            return await this.tools.massGetProperty((args as any)?.paths as string[], (args as any)?.propertyName as string);
          
          // Object Creation/Deletion Tools
          case 'create_object':
            return await this.tools.createObject((args as any)?.className as string, (args as any)?.parent as string, (args as any)?.name);
          case 'create_object_with_properties':
            return await this.tools.createObjectWithProperties((args as any)?.className as string, (args as any)?.parent as string, (args as any)?.name, (args as any)?.properties);
          case 'mass_create_objects':
            return await this.tools.massCreateObjects((args as any)?.objects);
          case 'mass_create_objects_with_properties':
            return await this.tools.massCreateObjectsWithProperties((args as any)?.objects);
          case 'delete_object':
            return await this.tools.deleteObject((args as any)?.instancePath as string);
          
          // Smart Duplication Tools
          case 'smart_duplicate':
            return await this.tools.smartDuplicate((args as any)?.instancePath as string, (args as any)?.count as number, (args as any)?.options);
          case 'mass_duplicate':
            return await this.tools.massDuplicate((args as any)?.duplications);
          
          // Calculated Property Tools
          case 'set_calculated_property':
            return await this.tools.setCalculatedProperty((args as any)?.paths as string[], (args as any)?.propertyName as string, (args as any)?.formula as string, (args as any)?.variables);
          
          // Relative Property Tools
          case 'set_relative_property':
            return await this.tools.setRelativeProperty((args as any)?.paths as string[], (args as any)?.propertyName as string, (args as any)?.operation, (args as any)?.value, (args as any)?.component);
          
          // Script Management Tools
          case 'get_script_source':
            return await this.tools.getScriptSource((args as any)?.instancePath as string, (args as any)?.startLine, (args as any)?.endLine);
          case 'get_script_snapshot':
            return await this.tools.getScriptSnapshot((args as any)?.instancePath as string, (args as any)?.startLine, (args as any)?.endLine);
          case 'set_script_source':
            return await this.tools.setScriptSource((args as any)?.instancePath as string, (args as any)?.source as string, (args as any)?.expectedHash as string | undefined);
          case 'begin_script_source_upload':
            return await this.tools.beginScriptSourceUpload(
              (args as any)?.instancePath as string,
              (args as any)?.expectedHash as string | undefined,
              (args as any)?.mode as 'set' | 'apply_and_verify' | undefined,
            );
          case 'append_script_source_upload_chunk':
            return await this.tools.appendScriptSourceUploadChunk(
              (args as any)?.uploadId as string,
              (args as any)?.chunk as string,
              (args as any)?.chunkIndex as number | undefined,
            );
          case 'commit_script_source_upload':
            return await this.tools.commitScriptSourceUpload(
              (args as any)?.uploadId as string,
              (args as any)?.verifyNeedle as string | undefined,
              (args as any)?.rollbackOnFailure as boolean | undefined,
              (args as any)?.preferFast as boolean | undefined,
            );
          case 'cancel_script_source_upload':
            return await this.tools.cancelScriptSourceUpload((args as any)?.uploadId as string);
          case 'set_script_source_checked':
            return await this.tools.setScriptSourceChecked((args as any)?.instancePath as string, (args as any)?.source as string, (args as any)?.expectedHash as string);
          case 'set_script_source_fast':
            return await this.tools.setScriptSourceFast((args as any)?.instancePath as string, (args as any)?.source as string, (args as any)?.verify as boolean | undefined);
          case 'set_script_source_fast_gzip':
            return await this.tools.setScriptSourceFastGzip(
              (args as any)?.instancePath as string,
              (args as any)?.sourceGzipBase64 as string,
              (args as any)?.verify as boolean | undefined
            );
          case 'create_script_snapshot':
            return await this.tools.createScriptSnapshot(
              (args as any)?.instancePath as string,
              (args as any)?.label as string | undefined
            );
          case 'list_script_snapshots':
            return await this.tools.listScriptSnapshots((args as any)?.instancePath as string | undefined);
          case 'rollback_script_snapshot':
            return await this.tools.rollbackScriptSnapshot(
              (args as any)?.snapshotId as string,
              (args as any)?.verify as boolean | undefined
            );
          case 'apply_and_verify_script_source':
            return await this.tools.applyAndVerifyScriptSource(
              (args as any)?.instancePath as string,
              (args as any)?.source as string,
              (args as any)?.expectedHash as string | undefined,
              (args as any)?.verifyNeedle as string | undefined,
              (args as any)?.rollbackOnFailure as boolean | undefined,
              (args as any)?.preferFast as boolean | undefined
            );

          // Partial Script Editing Tools
          case 'edit_script_lines':
            return await this.tools.editScriptLines((args as any)?.instancePath as string, (args as any)?.startLine as number, (args as any)?.endLine as number, (args as any)?.newContent as string);
          case 'insert_script_lines':
            return await this.tools.insertScriptLines((args as any)?.instancePath as string, (args as any)?.afterLine as number, (args as any)?.newContent as string);
          case 'delete_script_lines':
            return await this.tools.deleteScriptLines((args as any)?.instancePath as string, (args as any)?.startLine as number, (args as any)?.endLine as number);
          case 'batch_script_edits':
            return await this.tools.batchScriptEdits(
              (args as any)?.instancePath as string,
              (args as any)?.operations as any[],
              (args as any)?.expectedHash as string | undefined,
              (args as any)?.rollbackOnFailure as boolean | undefined,
              (args as any)?.fastMode as boolean | undefined
            );
          case 'replace_script_function':
            return await this.tools.replaceScriptFunction(
              (args as any)?.instancePath as string,
              (args as any)?.functionName as string,
              (args as any)?.newFunctionContent as string,
              (args as any)?.expectedHash as string | undefined,
            );
          case 'get_luau_diagnostics':
            return await this.tools.getLuauDiagnostics({
              instancePaths: (args as any)?.instancePaths as string[] | undefined,
              includeSourceHints: (args as any)?.includeSourceHints as boolean | undefined,
            });

          // Attribute Tools
          case 'get_attribute':
            return await this.tools.getAttribute((args as any)?.instancePath as string, (args as any)?.attributeName as string);
          case 'set_attribute':
            return await this.tools.setAttribute((args as any)?.instancePath as string, (args as any)?.attributeName as string, (args as any)?.attributeValue, (args as any)?.valueType);
          case 'get_attributes':
            return await this.tools.getAttributes((args as any)?.instancePath as string);
          case 'delete_attribute':
            return await this.tools.deleteAttribute((args as any)?.instancePath as string, (args as any)?.attributeName as string);

          // Tag Tools (CollectionService)
          case 'get_tags':
            return await this.tools.getTags((args as any)?.instancePath as string);
          case 'add_tag':
            return await this.tools.addTag((args as any)?.instancePath as string, (args as any)?.tagName as string);
          case 'remove_tag':
            return await this.tools.removeTag((args as any)?.instancePath as string, (args as any)?.tagName as string);
          case 'get_tagged':
            return await this.tools.getTagged((args as any)?.tagName as string);

          // Selection Tools
          case 'get_selection':
            return await this.tools.getSelection();
          case 'cancel_pending_writes':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(this.tools.cancelPendingWrites((args as any)?.prefix as string | undefined), null, 2)
                }
              ]
            };
          case 'execute_luau':
            return await this.tools.executeLuau((args as any)?.code as string);
          case 'start_playtest':
            return await this.tools.startPlaytest((args as any)?.mode as string);
          case 'stop_playtest':
            return await this.tools.stopPlaytest();
          case 'get_playtest_output':
            return await this.tools.getPlaytestOutput();
          case 'ai_control_player':
            return await this.tools.aiControlPlayer((args as any)?.action as string, (args as any)?.duration as number, (args as any)?.speed as number);
          case 'ai_get_player_state':
            return await this.tools.aiGetPlayerState((args as any)?.includeNearby as boolean, (args as any)?.nearbyRadius as number);
          case 'ai_interact_with_object':
            return await this.tools.aiInteractWithObject((args as any)?.objectPath as string, (args as any)?.action as string, (args as any)?.playerIndex as number);
          case 'ai_teleport_player':
            return await this.tools.aiTeleportPlayer((args as any)?.position, (args as any)?.rotation, (args as any)?.playerIndex as number);
          case 'get_game_state':
            return await this.tools.getGameState((args as any)?.scope as string, (args as any)?.maxResults as number);
          case 'capture_debug_logs':
            return await this.tools.captureDebugLogs((args as any)?.type as string, (args as any)?.maxLines as number, (args as any)?.sinceTimestamp as number);
          case 'open_debug_log_stream':
            return await this.tools.openDebugLogStream((args as any)?.type as string);
          case 'poll_debug_log_stream':
            return await this.tools.pollDebugLogStream((args as any)?.cursorId as string, (args as any)?.maxLines as number);
          case 'close_debug_log_stream':
            return await this.tools.closeDebugLogStream((args as any)?.cursorId as string);
          case 'get_runtime_errors':
            return await this.tools.getRuntimeErrors((args as any)?.clearAfter as boolean);
          case 'execute_test_sequence':
            return await this.tools.executeTestSequence((args as any)?.steps as any[], (args as any)?.stopOnError as boolean);
          case 'watch_property_changes':
            return await this.tools.watchPropertyChanges((args as any)?.instancePath as string, (args as any)?.properties as string[], (args as any)?.duration as number);
          case 'get_performance_metrics':
            return await this.tools.getPerformanceMetrics((args as any)?.category as string);
          case 'capture_performance_snapshot':
            return await this.tools.capturePerformanceSnapshot(
              (args as any)?.category as string,
              (args as any)?.sampleCount as number,
              (args as any)?.intervalMs as number,
            );
          case 'inspect_terrain':
            return await this.tools.inspectTerrain((args as any)?.region, (args as any)?.includeNavmesh as boolean);
          case 'get_network_stats':
            return await this.tools.getNetworkStats((args as any)?.includePlayers as boolean);
          case 'simulate_input':
            return await this.tools.simulateInput((args as any)?.inputType as string, (args as any)?.target as string, (args as any)?.position, (args as any)?.keyCode as string);
          case 'parse_ui_reference':
            return await this.tools.parseUIReference((args as any)?.imageData as string, (args as any)?.options);
          case 'generate_ui':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(await this.tools.generateUI((args as any) as any), null, 2)
                }
              ]
            };
          case 'parse_and_generate_ui':
            const combinedResult = await this.tools.parseAndGenerateUI(
              (args as any)?.imageData as string,
              (args as any)?.options
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(combinedResult, null, 2)
                }
              ]
            };

          // Agent Management Tools
          case 'agent_chat':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    response: '[Agent Chat] Message received. External provider wiring is disabled in this build.',
                    agentId: (args as any)?.agentId || 'default',
                    threadId: (args as any)?.threadId || 'new_thread',
                  }, null, 2)
                }
              ]
            };
          case 'agent_status':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    agents: [],
                    totalTokensIn: 0,
                    totalTokensOut: 0,
                    activeAgentCount: 0,
                  }, null, 2)
                }
              ]
            };
          case 'agent_control':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    affectedAgents: [(args as any)?.agentId || 'default']
                  }, null, 2)
                }
              ]
            };
          case 'get_agent_threads':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ threads: [] }, null, 2)
                }
              ]
            };
          case 'get_agent_metrics':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    tokensInTotal: 0,
                    tokensOutTotal: 0,
                    requestsTotal: 0,
                    avgLatencyMs: 0,
                    p50LatencyMs: 0,
                    p99LatencyMs: 0,
                    laneStats: []
                  }, null, 2)
                }
              ]
            };

          // ATO Agentic Tools
          case 'subscribe_file_tree':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'File tree subscription registered. Deltas will be broadcast via WebSocket.',
                    path: (args as any)?.path || 'game',
                  }, null, 2)
                }
              ]
            };
          case 'get_task_status':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    taskId: (args as any)?.taskId || null,
                    status: 'unknown',
                    message: 'Task tracking backend is not integrated yet.'
                  }, null, 2)
                }
              ]
            };
          case 'list_tasks':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    tasks: [],
                    stats: { total: 0, queued: 0, running: 0, completed: 0, failed: 0 }
                  }, null, 2)
                }
              ]
            };
          case 'execute_direct_command':
            {
              const command = (args as any)?.command as string;
              const params = (args as any)?.params as Record<string, unknown> ?? {};
              const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              this.bridge.emitTaskUpdate({
                taskId,
                status: 'running',
                progress: 0,
                agentId: (args as any)?.agentId || 'ui-direct',
                message: `Executing command: ${command}`,
              });
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      taskId,
                      command,
                      message: `Command ${command} started. Track progress via task updates.`,
                    }, null, 2)
                  }
                ]
              };
            }
          case 'cancel_task':
            {
              const taskId = (args as any)?.taskId as string;
              const existing = this.bridge.getTaskUpdate(taskId);
              if (existing) {
                this.bridge.emitTaskUpdate({
                  ...existing,
                  taskId,
                  status: 'cancelled',
                  progress: existing.progress,
                  message: 'Task cancelled by user',
                });
              }
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      taskId,
                      message: `Task ${taskId} cancellation requested.`,
                    }, null, 2)
                  }
                ]
              };
            }
          case 'list_direct_commands':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    commands: this.bridge.getDirectCommands(),
                    count: this.bridge.getDirectCommands().length,
                  }, null, 2)
                }
              ]
            };

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async run() {
    const basePort = process.env.ROBLOX_STUDIO_PORT ? parseInt(process.env.ROBLOX_STUDIO_PORT) : 3002;
    const maxPort = basePort + 4;
    const host = resolveServerHost(process.env.ROBLOX_STUDIO_HOST);
    const hostFallbacks = getServerHostFallbacks(host);
    const httpServerState = createHttpServerSharedState();
    const httpServer = createHttpServer(this.tools, this.bridge, httpServerState);
    const listenWithFallback = (
      app: ReturnType<typeof createHttpServer>,
      port: number,
      listeningMessage: string
    ) =>
      new Promise<void>((resolve, reject) => {
        const listener = app.listen(port, host);

        const cleanup = () => {
          listener.removeListener('error', onError);
          listener.removeListener('listening', onListening);
        };

        const onError = (err: NodeJS.ErrnoException) => {
          cleanup();
          try {
            listener.close();
          } catch {
            // Ignore close errors from a failed listen attempt.
          }
          reject(err);
        };

        const onListening = () => {
          cleanup();
          console.error(listeningMessage);
          resolve();
        };

        listener.once('error', onError);
        listener.once('listening', onListening);
      });

    let boundPort = 0;
    for (let port = basePort; port <= maxPort; port++) {
      try {
        await listenWithFallback(httpServer, port, `HTTP server listening on ${host}:${port} for Studio plugin`);
        boundPort = port;
        break;
      } catch (err: any) {
        if (err.code === 'EADDRINUSE') {
          console.error(`Port ${port} in use, trying next...`);
          if (port === maxPort) {
            throw new Error(`All ports ${basePort}-${maxPort} are in use. Stop some MCP server instances and retry.`);
          }
          continue;
        }
        throw err;
      }
    }

    for (const fallbackHost of hostFallbacks) {
      const fallbackServer = createHttpServer(this.tools, this.bridge, httpServerState);
      try {
        await new Promise<void>((resolve, reject) => {
          const listener = fallbackServer.listen(boundPort, fallbackHost);

          const cleanup = () => {
            listener.removeListener('error', onError);
            listener.removeListener('listening', onListening);
          };

          const onError = (err: NodeJS.ErrnoException) => {
            cleanup();
            try {
              listener.close();
            } catch {
              // Ignore close errors from a failed listen attempt.
            }
            reject(err);
          };

          const onListening = () => {
            cleanup();
            console.error(`IPv4 loopback fallback also listening on ${fallbackHost}:${boundPort} for Studio plugin`);
            resolve();
          };

          listener.once('error', onError);
          listener.once('listening', onListening);
        });
      } catch (err: any) {
        console.error(`IPv4 loopback fallback unavailable on ${fallbackHost}:${boundPort} (${err.code || err.message})`);
      }
    }

    const LEGACY_PORT = 58741;
    let legacyServer: ReturnType<typeof createHttpServer> | undefined;
    if (boundPort !== LEGACY_PORT) {
      const legacy = createHttpServer(this.tools, this.bridge, httpServerState);
      legacyServer = legacy;
      try {
        await listenWithFallback(
          legacy,
          LEGACY_PORT,
          `Legacy HTTP server also listening on ${host}:${LEGACY_PORT} for old plugins`
        );
        (legacy as any).setMCPServerActive(true);
        for (const fallbackHost of hostFallbacks) {
          const legacyFallback = createHttpServer(this.tools, this.bridge, httpServerState);
          try {
            await new Promise<void>((resolve, reject) => {
              const listener = legacyFallback.listen(LEGACY_PORT, fallbackHost);

              const cleanup = () => {
                listener.removeListener('error', onError);
                listener.removeListener('listening', onListening);
              };

              const onError = (err: NodeJS.ErrnoException) => {
                cleanup();
                try {
                  listener.close();
                } catch {
                  // Ignore close errors from a failed listen attempt.
                }
                reject(err);
              };

              const onListening = () => {
                cleanup();
                console.error(`Legacy IPv4 loopback fallback also listening on ${fallbackHost}:${LEGACY_PORT} for old plugins`);
                resolve();
              };

              listener.once('error', onError);
              listener.once('listening', onListening);
            });
            (legacyFallback as any).setMCPServerActive(true);
          } catch (err: any) {
            console.error(`Legacy IPv4 loopback fallback unavailable on ${fallbackHost}:${LEGACY_PORT} (${err.code || err.message})`);
          }
        }
      } catch {
        console.error(`Legacy port ${LEGACY_PORT} in use, skipping backward-compat listener`);
      }
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Roblox Studio MCP server running on stdio');
    
    (httpServer as any).setMCPServerActive(true);
    console.error('MCP server marked as active');

    this.bridge.registerDirectCommand({
      name: 'Analyze Project',
      description: 'Analyze project architecture and generate a report',
      endpoint: 'analyze_project_architecture',
    });
    this.bridge.registerDirectCommand({
      name: 'Refresh Structure Map',
      description: 'Rebuild the cached instance tree structure',
      endpoint: 'refresh_structure_map',
    });
    this.bridge.registerDirectCommand({
      name: 'Get Diagnostics',
      description: 'Run diagnostics to check for issues',
      endpoint: 'get_diagnostics',
    });
    this.bridge.registerDirectCommand({
      name: 'Find Deprecated APIs',
      description: 'Scan scripts for deprecated Roblox APIs',
      endpoint: 'lint_deprecated_apis',
    });
    this.bridge.registerDirectCommand({
      name: 'Check Script Drift',
      description: 'Compare Studio scripts with local source files',
      endpoint: 'check_script_drift',
    });

    console.error('Waiting for Studio plugin to connect...');
    
    setInterval(() => {
      (httpServer as any).trackMCPActivity();
      if (legacyServer) (legacyServer as any).trackMCPActivity();
      const pluginConnected = (httpServer as any).isPluginConnected();
      const mcpActive = (httpServer as any).isMCPServerActive();
      
      if (pluginConnected && mcpActive) {
        return;
      } else if (pluginConnected && !mcpActive) {
        console.error('Studio plugin connected, but MCP server inactive');
      } else if (!pluginConnected && mcpActive) {
        console.error('MCP server active, waiting for Studio plugin...');
      } else {
        console.error('Waiting for connections...');
      }
    }, 5000);
    
    setInterval(() => {
      this.bridge.cleanupOldRequests();
    }, 5000);
  }
}

const server = new RobloxStudioMCPServer();
server.run().catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});

/* global NodeRequire */
import path from 'path';
import glob from 'glob';
import fs from 'fs-extra';
import childProcess from 'child_process';
import { DepGraph } from 'dependency-graph';
import sortPackageJson from 'sort-package-json';
import { JSONExt, JSONObject } from '@lumino/coreutils';

type Dict<T> = { [key: string]: T };

const backSlash = /\\/g;

/**
 *  Exit with an error code on uncaught error.
 */
export function exitOnUuncaughtException(): void {
  process.on('uncaughtException', function (err) {
    console.error('Uncaught exception', err);
    process.exit(1);
  });
}

/**
 * Get all of the lerna package paths.
 */
export function getLernaPaths(basePath = '.'): string[] {
  basePath = path.resolve(basePath);
  let packages;
  try {
    let baseConfig = require(path.join(basePath, 'package.json'));
    if (baseConfig.workspaces) {
      packages = baseConfig.workspaces.packages || baseConfig.workspaces;
    } else {
      baseConfig = require(path.join(basePath, 'lerna.json'));
      packages = baseConfig.packages;
    }
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `No yarn workspace / lerna package list found in ${basePath}`
      );
    }
    throw e;
  }
  let paths: string[] = [];
  for (const config of packages) {
    paths = paths.concat(glob.sync(path.join(basePath, config)));
  }
  return paths.filter(pkgPath => {
    return fs.existsSync(path.join(pkgPath, 'package.json'));
  });
}

/**
 * Get all of the core package paths.
 */
export function getCorePaths(): string[] {
  const spec = path.resolve(path.join('.', 'packages', '*'));
  return glob.sync(spec);
}

/**
 * Write a package.json if necessary.
 *
 * @param data - The package data.
 *
 * @oaram pkgJsonPath - The path to the package.json file.
 *
 * @returns Whether the file has changed.
 */
export function writePackageData(
  pkgJsonPath: string,
  data: JSONObject
): boolean {
  const text = JSON.stringify(sortPackageJson(data), null, 2) + '\n';
  const orig = fs.readFileSync(pkgJsonPath, 'utf8').split('\r\n').join('\n');
  if (text !== orig) {
    fs.writeFileSync(pkgJsonPath, text, 'utf8');
    return true;
  }
  return false;
}

/**
 * Read a json file.
 */
export function readJSONFile(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw `Cannot read JSON for path ${filePath}: ${e}`;
  }
}

/**
 * Write a json file.
 */
export function writeJSONFile(filePath: string, data: JSONObject): boolean {
  function sortObjByKey(value: any): any {
    // https://stackoverflow.com/a/35810961
    return typeof value === 'object'
      ? Array.isArray(value)
        ? value.map(sortObjByKey)
        : Object.keys(value)
            .sort()
            .reduce((o: any, key) => {
              const v = value[key];
              o[key] = sortObjByKey(v);
              return o;
            }, {})
      : value;
  }
  const text = JSON.stringify(data, sortObjByKey(data), 2) + '\n';
  let orig = {};
  try {
    orig = readJSONFile(filePath);
  } catch (e) {
    // no-op
  }
  if (!JSONExt.deepEqual(data, orig)) {
    fs.writeFileSync(filePath, text, 'utf8');
    return true;
  }
  return false;
}

/**
 * Simple template substitution for template vars of the form {{name}}
 *
 * @param templ: the template string.
 * Ex: `This header generated by {{funcName}}`
 *
 * @param subs: an object in which the parameter keys are the template
 * variables and the parameter values are the substitutions.
 *
 * @param options: function options.
 *
 * @param options.autoindent: default = true. If true, will try to match
 * indentation level of {{var}} in substituted template.
 *
 * @param options.end: default = '\n'. Inserted at the end of
 * a template post-substitution and post-trim.
 *
 * @returns the input template with all {{vars}} substituted, then `.trim`-ed.
 */
export function fromTemplate(
  templ: string,
  subs: Dict<string>,
  options: { autoindent?: boolean; end?: string } = {}
): string {
  // default options values
  const autoindent =
    options.autoindent === undefined ? true : options.autoindent;
  const end = options.end === undefined ? '\n' : options.end;

  Object.keys(subs).forEach(key => {
    const val = subs[key];

    if (autoindent) {
      // try to match the indentation level of the {{var}} in the input template.
      templ = templ.split(`{{${key}}}`).reduce((acc, cur) => {
        // Regex: 0 or more non-newline whitespaces followed by end of string
        const indentRe = acc.match(/([^\S\r\n]*).*$/);
        const indent = indentRe ? indentRe[1] : '';
        return acc + val.split('\n').join('\n' + indent) + cur;
      });
    } else {
      templ = templ.split(`{{${key}}}`).join(val);
    }
  });

  return templ.trim() + end;
}

/**
 *
 * Call a command, checking its status.
 */
export function checkStatus(cmd: string): number | null {
  const data = childProcess.spawnSync(cmd, { shell: true });
  return data.status;
}

/**
 * Get the current version of JupyterLab
 */
export function getPythonVersion(): string {
  const cmd = 'python setup.py --version';
  return run(cmd, { stdio: 'pipe' }, true);
}

/**
 * Get the current version of a package
 */
export function getJSVersion(pkg: string): string {
  const filePath = path.resolve(
    path.join('.', 'packages', pkg, 'package.json')
  );
  const data = readJSONFile(filePath);
  return data.version;
}

/**
 * Pre-bump.
 */
export function prebump(): void {
  // Ensure bump2version is installed (active fork of bumpversion)
  run('python -m pip install bump2version');

  // Make sure we start in a clean git state.
  const status = run('git status --porcelain', {
    stdio: 'pipe',
    encoding: 'utf8'
  });
  if (status.length > 0) {
    throw new Error(
      `Must be in a clean git state with no untracked files.
Run "git status" to see the issues.

${status}`
    );
  }
}

/**
 * Post-bump.
 */
export function postbump(commit = true): void {
  run('jlpm run integrity');

  // Commit changes.
  if (commit) {
    run('git commit -am "[ci skip] bump version"');
  }
}

/**
 * Run a command with terminal output.
 *
 * @param cmd - The command to run.
 */
export function run(
  cmd: string,
  options: childProcess.ExecSyncOptions = {},
  quiet?: boolean
): string {
  options = options || {};
  options['stdio'] = options.stdio || 'inherit';
  if (!quiet) {
    console.debug('>', cmd);
  }
  const value = childProcess.execSync(cmd, options);
  if (value === null) {
    return '';
  }
  return value
    .toString()
    .replace(/(\r\n|\n)$/, '')
    .trim();
}

/**
 * Get a graph that has all of the package data for the local packages and their
 * first order dependencies.
 */
export function getPackageGraph(): DepGraph<Dict<unknown>> {
  // Pick up all the package versions.
  const paths = getLernaPaths();
  const locals: Dict<any> = {};

  // These two are not part of the workspaces but should be
  // considered part of the dependency graph.
  paths.push('./jupyterlab/tests/mock_packages/extension');
  paths.push('./jupyterlab/tests/mock_packages/mimeextension');

  // Gather all of our package data.
  paths.forEach(pkgPath => {
    // Read in the package.json.
    let data: any;
    try {
      data = readJSONFile(path.join(pkgPath, 'package.json'));
    } catch (e) {
      console.error(e);
      return;
    }
    locals[data.name] = data;
  });

  // Build up a dependency graph from all our local packages and
  // their first order dependencies.
  const graph = new DepGraph<Dict<unknown>>();
  Object.keys(locals).forEach(name => {
    const data = locals[name];
    graph.addNode(name, data);
    const deps: Dict<Array<string>> = data.dependencies || {};
    Object.keys(deps).forEach(depName => {
      if (!graph.hasNode(depName)) {
        let depData: any;
        // get data from locals if available, otherwise from
        // third party library.
        if (depName in locals) {
          depData = locals[depName];
        } else {
          depData = requirePackage(name, depName);
        }
        graph.addNode(depName, depData);
      }
      graph.addDependency(data.name, depName);
    });
  });

  return graph;
}

/**
 * Resolve a `package.json` in the `module` starting at resolution from the `parentModule`.
 *
 * We could just use "require(`${depName}/package.json`)", however this won't work for modules
 * that are not hoisted to the top level.
 */
function requirePackage(parentModule: string, module: string): NodeRequire {
  const packagePath = `${module}/package.json`;
  let parentModulePath: string;
  // This will fail when the parent module cannot be loaded, like `@jupyterlab/test-root`
  try {
    parentModulePath = require.resolve(parentModule);
  } catch {
    return require(packagePath);
  }
  const requirePath = require.resolve(packagePath, {
    paths: [parentModulePath]
  });
  return require(requirePath);
}

/**
 * Ensure the given path uses '/' as path separator.
 */
export function ensureUnixPathSep(source: string): string {
  if (path.sep === '/') {
    return source;
  }
  return source.replace(backSlash, '/');
}

/**
 * Get the last portion of a path, without its extension (if any).
 *
 * @param pathArg - The file path.
 *
 * @returns the last part of the path, sans extension.
 */
export function stem(pathArg: string): string {
  return path.basename(pathArg).split('.').shift()!;
}

/**
 * Given a 'snake-case', 'snake_case', or 'snake case' string,
 * will return the camel case version: 'snakeCase'.
 *
 * @param str: the snake-case input string.
 *
 * @param upper: default = false. If true, the first letter of the
 * returned string will be capitalized.
 *
 * @returns the camel case version of the input string.
 */
export function camelCase(str: string, upper: boolean = false): string {
  return str.replace(/(?:^\w|[A-Z]|\b\w|\s+|-+|_+)/g, function (match, index) {
    if (+match === 0 || match[0] === '-') {
      return '';
    } else if (index === 0 && !upper) {
      return match.toLowerCase();
    } else {
      return match.toUpperCase();
    }
  });
}

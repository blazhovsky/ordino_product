/**
 * Created by Samuel Gratzl on 28.11.2016.
 */

const Promise = require('bluebird');
const path = require('path');
const fs = Promise.promisifyAll(require('fs-extra'));
const chalk = require('chalk');
const pkg = require('./package.json');
/**
 * arguments:
 *  * --quiet ... reduce log messages
 *  * --serial ... build elements sequentially
 *  * --skipTests
 *  * --useSSH
 *  * --skipCleanUp ... skip cleaning up old docker images
 *  * --skipSaveImage ... skip saving the generated docker images
 *  * --pushTo ... push docker images to the given registry
 *  * --noDefaultTags ... don't push generated default tag :<timestamp>
 *  * --pushExtra ... push additional custom tag: e.g., --pushExtra=develop
 *  * --forceLabel ... force to use the label even only a single service exists
 */
const argv = require('yargs-parser')(process.argv.slice(2));

const quiet = argv.quiet !== undefined;

const now = new Date();
const prefix = (n) => n < 10 ? ('0' + n) : n.toString();
const buildId = `${now.getUTCFullYear()}${prefix(now.getUTCMonth())}${prefix(now.getUTCDate())}-${prefix(now.getUTCHours())}${prefix(now.getUTCMinutes())}${prefix(now.getUTCSeconds())}`;
pkg.version = pkg.version.replace('SNAPSHOT', buildId);
const env = Object.assign({}, process.env);

function toRepoUrl(url) {
  if (url.startsWith('git@')) {
    if (argv.useSSH) {
      return url;
    }
    // have an ssh url need an http url
    const m = url.match(/(https?:\/\/([^/]+)\/|git@(.+):)([\w\d-_/]+)(.git)?/);
    return `https://${m[3]}/${m[4]}.git`;
  }
  if (url.startsWith('http')) {
    if (!argv.useSSH) {
      return url;
    }
    // have a http url need an ssh url
    const m = url.match(/(https?:\/\/([^/]+)\/|git@(.+):)([\w\d-_/]+)(.git)?/);
    return `git@${m[2]}:${m[4]}.git`;
  }
  if (!url.includes('/')) {
    url = `Caleydo/${url}`;
  }
  if (argv.useSSH) {
    return `git@github.com:${url}.git`;
  }
  return `https://github.com/${url}.git`;
}

function guessUserName(repo) {
  // extract the host
  const host = repo.match(/:\/\/([^/]+)/)[1];
  const hostClean = host.replace(/\./g, '_').toUpperCase();
  // e.g. GITHUB_COM_CREDENTIALS
  const envVar = process.env[`${hostClean}_CREDENTIALS`];
  if (envVar) {
    return envVar;
  }
  return process.env.PHOVEA_GITHUB_CREDENTIALS;
}

function toRepoUrlWithUser(url) {
  const repo = toRepoUrl(url);
  if (repo.startsWith('git@')) { // ssh
    return repo;
  }
  const usernameAndPassword = guessUserName(repo);
  if (!usernameAndPassword) { // ssh or no user given
    return repo;
  }
  return repo.replace('://', `://${usernameAndPassword}@`);
}

function fromRepoUrl(url) {
  if (url.includes('.git')) {
    return url.match(/\/([^/]+)\.git/)[0];
  }
  return url.slice(url.lastIndexOf('/') + 1);
}

function downloadDataUrl(url, dest) {
  if (!url.startsWith('http')) {
    url = `https://s3.eu-central-1.amazonaws.com/phovea-data-packages/${url}`;
  }
  const http = require(url.startsWith('https') ? 'https' : 'http');
  console.log(chalk.blue('download file', url));
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    http.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', reject);
  });
}

function toDownloadName(url) {
  if (!url.startsWith('http')) {
    return url;
  }
  return url.substring(url.lastIndexOf('/') + 1);
}

function downloadDataFile(desc, destDir, cwd) {
  if (typeof desc === 'string') {
    desc = {
      type: 'url',
      url: desc
    };
  }
  switch (desc.type) {
    case 'url': {
      const destName = toDownloadName(desc.url);
      return fs.ensureDirAsync(destDir).then(() => downloadDataUrl(desc.url, path.join(destDir, destName)));
    }
    case 'repo': {
      desc.name = desc.name || fromRepoUrl(desc.repo);
      let downloaded;
      if (fs.existsSync(path.join(cwd, desc.name))) {
        downloaded = Promise.resolve(desc);
      } else {
        downloaded = cloneRepo(desc, cwd);
      }
      return downloaded.then(() => fs.copyAsync(`${cwd}/${desc.name}/data`, `${destDir}/${desc.name}`));
    }
    default:
      console.error('unknown data type:', desc.type);
      return null;
  }
}

/**
 * spawns a child process
 * @param cmd command as array
 * @param args arguments
 * @param opts options
 */
function spawn(cmd, args, opts) {
  const spawn = require('child_process').spawn;
  const _ = require('lodash');
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, typeof args === 'string' ? args.split(' ') : args, _.merge({stdio: ['ignore', 1, 2]}, opts));
    p.on('close', (code, signal) => {
      if (code === 0) {
        console.info(cmd, 'ok status code', code, signal);
        resolve(code);
      } else {
        console.error(cmd, 'status code', code, signal);
        reject(`${cmd} failed with status code ${code} ${signal}`);
      }
    });
  });
}

/**
 * run npm with the given args
 * @param cwd working directory
 * @param cmd the command to execute as a string
 * @return {*}
 */
function npm(cwd, cmd) {
  console.log(cwd, chalk.blue('running npm', cmd));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawn(npm, (cmd || 'install').split(' '), {cwd, env});
}

/**
 * runs docker command
 * @param cwd
 * @param cmd
 * @return {*}
 */
function docker(cwd, cmd) {
  console.log(cwd, chalk.blue('running docker', cmd));
  return spawn('docker', (cmd || 'build .').split(' '), {cwd, env});
}

function dockerSave(image, target) {
  console.log(chalk.blue(`running docker save ${image} | gzip > ${target}`));
  const spawn = require('child_process').spawn;
  const opts = {env};
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['save', image], opts);
    const p2 = spawn('gzip', [], opts);
    p.stdout.pipe(p2.stdin);
    p2.stdout.pipe(fs.createWriteStream(target));
    if (!quiet) {
      p.stderr.on('data', (data) => console.error(chalk.red(data.toString())));
      p2.stderr.on('data', (data) => console.error(chalk.red(data.toString())));
    }
    p2.on('close', (code) => code === 0 ? resolve() : reject(code));
  });
}

function dockerRemoveImages(productName) {
  if (argv.skipCleanUp) {
    return Promise.resolve();
  }
  console.log(chalk.blue(`docker images | grep ${productName} | awk '{print $1":"$2}') | xargs --no-run-if-empty docker rmi`));
  const spawn = require('child_process').spawn;
  const opts = {env};
  return new Promise((resolve) => {
    const p = spawn('docker', ['images'], opts);
    const p2 = spawn('grep', [productName], opts);
    p.stdout.pipe(p2.stdin);
    const p3 = spawn('awk', ['{print $1":"$2}'], opts);
    p2.stdout.pipe(p3.stdin);
    const p4 = spawn('xargs', ['--no-run-if-empty', 'docker', 'rmi'], {env, stdio: [p3.stdout, 1, 2]});
    p4.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.log('invalid error code, but continuing');
        resolve();
      }
    });
  });
}

function createQuietTerminalAdapter() {
  const TerminalAdapter = require('yeoman-environment/lib/adapter');
  const impl = new TerminalAdapter();
  impl.log.write = function () {
    return this;
  };
  return impl;
}

/**
 * runs yo internally
 * @param generator
 * @param options
 * @param cwd
 */
function yo(generator, options, cwd) {
  const yeoman = require('yeoman-environment');
  // call yo internally
  const yeomanEnv = yeoman.createEnv([], {cwd, env}, quiet ? createQuietTerminalAdapter() : undefined);
  yeomanEnv.register(require.resolve('generator-phovea/generators/' + generator), 'phovea:' + generator);
  return new Promise((resolve, reject) => {
    try {
      console.log(cwd, chalk.blue('running yo phovea:' + generator));
      yeomanEnv.run('phovea:' + generator, options, resolve);
    } catch (e) {
      console.error('error', e, e.stack);
      reject(e);
    }
  });
}

function cloneRepo(p, cwd) {
  // either of them has to be defined
  p.name = p.name || fromRepoUrl(p.repo);
  p.repo = p.repo || `phovea/${p.name}`;
  p.branch = p.branch || 'master';

  if (/^[0-9a-f]+$/gi.test(p.branch)) {
    // clone a specific commit
    console.log(cwd, chalk.blue(`running git clone -n ${toRepoUrl(p.repo)} ${p.name}`));
    return spawn('git', ['clone', '-n', toRepoUrlWithUser(p.repo), p.name], {cwd}).then(() => {
      console.log(cwd, chalk.blue(`running git checkout ${p.branch}`));
      return spawn('git', ['checkout', p.branch], {cwd: cwd + '/' + p.name});
    });
  } else {
    console.log(cwd, chalk.blue(`running git clone --depth 1 -b ${p.branch} ${toRepoUrl(p.repo)} ${p.name}`));
    return spawn('git', ['clone', '--depth', '1', '-b', p.branch, toRepoUrlWithUser(p.repo), p.name], {cwd});
  }
}

function resolvePluginType(p, dir) {
  if (!fs.existsSync(`${dir}/${p.name}/.yo-rc.json`)) {
    p.pluginType = 'lib';
    p.isHybridType = false;
    return;
  }
  return fs.readJSONAsync(`${dir}/${p.name}/.yo-rc.json`).then((json) => {
    p.pluginType = json['generator-phovea'].type;
    p.isHybridType = p.pluginType.includes('-');
  });
}

function preBuild(p, dir) {
  const hasAdditional = p.additional.length > 0;
  let act = fs.emptyDirAsync(dir)
    .then(() => cloneRepo(p, dir))
    .then(() => resolvePluginType(p, dir));
  if (hasAdditional) {
    if (argv.serial) {
      p.additional.forEach((pi) => act = act.then(() => cloneRepo(pi, dir).then(resolvePluginType.bind(this, pi, dir))));
    } else {
      act = act
      .then(() => Promise.all(p.additional.map((pi) => cloneRepo(pi, dir).then(resolvePluginType.bind(this, pi, dir)))));
    }

  }
  return act;
}

function loadComposeFile(dir, p) {
  const composeFile = `${dir}/${p.name}/deploy/docker-compose.partial.yml`;
  if (fs.existsSync(composeFile)) {
    const yaml = require('yamljs');
    return fs.readFileAsync(composeFile).then((content) => yaml.parse(content.toString()));
  }
  return Promise.resolve({});
}

function patchComposeFile(p, composeTemplate) {
  const service = {};
  if (composeTemplate && composeTemplate.services) {
    const firstService = Object.keys(composeTemplate.services)[0];
    // copy data from first service
    Object.assign(service, composeTemplate.services[firstService]);
    delete service.build;
  }
  service.image = p.image;
  if (p.type === 'web' || p.type === 'static') {
    service.ports = ['80:80'];
  }
  const r = {
    version: '2.0',
    services: {}
  };
  r.services[p.label] = service;
  return r;
}

function patchDockerfile(p, dockerFile) {
  if (!p.baseImage) {
    return null;
  }
  return fs.readFileAsync(dockerFile).then((content) => {
    content = content.toString();
    // patch the Dockerfile by replacing the FROM statement
    const r = /^\s*FROM (.+)\s*$/igm;
    const fromImage = r.exec(content)[1];
    console.log(`patching ${dockerFile} change from ${fromImage} -> ${p.baseImage}`);
    content = content.replace(r, `FROM ${p.baseImage}`);
    return fs.writeFileAsync(dockerFile, content);
  });
}

function postBuild(p, dir, buildInSubDir) {
  return Promise.resolve(null)
    .then(() => patchDockerfile(p, `${dir}${buildInSubDir ? '/' + p.name : ''}/deploy/Dockerfile`))
    .then(() => docker(`${dir}${buildInSubDir ? '/' + p.name : ''}`, `build -t ${p.image} -f deploy/Dockerfile .`))
    .then(() => !argv.pushExtra ? null : docker(`${dir}`, `tag ${p.image} ${p.image.substring(0, p.image.lastIndexOf(':'))}:${argv.pushExtra}`))
    .then(() => argv.skipSaveImage ? null : dockerSave(p.image, `build/${p.label}_image.tar.gz`))
    .then(() => Promise.all([loadComposeFile(dir, p).then(patchComposeFile.bind(null, p))].concat(p.additional.map((pi) => loadComposeFile(dir, pi)))))
    .then(mergeCompose);
}

function buildWebApp(p, dir, yoWorkspaceOptions) {
  console.log(dir, chalk.blue('building web application:'), p.label);
  const name = p.name;
  const hasAdditional = p.additional.length > 0;
  let act = preBuild(p, dir);
  // let act = Promise.resolve(null);
  if (hasAdditional) {
    act = act
      .then(() => yo('workspace', yoWorkspaceOptions, dir))
      .then(() => npm(dir, 'install'));
    // test all modules
    if (hasAdditional && !argv.skipTests) {
      act = act.then(() => Promise.all(p.additional.map((pi) => npm(dir, `run test${pi.isHybridType ? ':web' : ''}:${pi.name}`))));
    }
    act = act
      .then(() => npm(dir, `run dist${p.isHybridType ? ':web' : ''}:${p.name}`));
  } else {
    act = act
      .then(() => npm(dir + '/' + name, 'install'))
      .then(() => npm(dir + '/' + name, `run dist${p.isHybridType ? ':web' : ''}`));
  }
  return act
    .then(() => fs.renameAsync(`${dir}/${p.name}/dist/${p.name}.tar.gz`, `./build/${p.label}.tar.gz`))
    .then(postBuild.bind(null, p, dir, true));
}

function buildServerApp(p, dir, yoWorkspaceOptions) {
  console.log(dir, chalk.blue('building service package:'), p.label);
  const name = p.name;

  let act = preBuild(p, dir);
  act = act
    .then(() => yo('workspace', yoWorkspaceOptions, dir));

  if (!argv.skipTests) {
    act = act
      .then(() => console.log(chalk.yellow('create test environment')))
      .then(() => spawn('pip', 'install --no-cache-dir -r requirements.txt', {cwd: dir}))
      .then(() => spawn('pip', 'install --no-cache-dir -r requirements_dev.txt', {cwd: dir}));
  }

  act = act
    .then(() => npm(dir + '/' + name, `run build${p.isHybridType ? ':python' : ''}`))
    .then(() => Promise.all(p.additional.map((pi) => npm(dir + '/' + pi.name, `run build${pi.isHybridType ? ':python' : ''}`))));

  // copy all together
  act = act
    .then(() => fs.ensureDirAsync(`${dir}/build/source`))
    .then(() => fs.copyAsync(`${dir}/${name}/build/source`, `${dir}/build/source/`))
    .then(() => Promise.all(p.additional.map((pi) => fs.copyAsync(`${dir}/${pi.name}/build/source`, `${dir}/build/source/`))));

  // copy data packages
  act = act.then(() => Promise.all(p.data.map((d) => downloadDataFile(d, `${dir}/build/source/_data`, dir))));
  // let act = Promise.resolve([]);

  // copy main deploy thing and create a docker out of it
  return act
    .then(() => fs.ensureDirAsync(`${dir}/deploy`))
    .then(() => fs.copyAsync(`${dir}/${name}/deploy`, `${dir}/deploy/`))
    .then(postBuild.bind(null, p, dir, false));
}

function buildImpl(d, dir) {
  const yoWorkspaceOptions = {
    noAdditionals: true,
    defaultApp: 'ordino_public',
    wsName: pkg.name,
    wsDescription: pkg.description,
    wsVersion: pkg.version
  };

  switch (d.type) {
    case 'static':
    case 'web':
      return buildWebApp(d, dir, yoWorkspaceOptions);
    case 'api':
      d.name = d.name || 'phovea_server';
      return buildServerApp(d, dir, yoWorkspaceOptions);
    case 'service':
      return buildServerApp(d, dir, yoWorkspaceOptions);
    default:
      console.error(chalk.red('unknown product type: ' + d.type));
      return Promise.resolve(null);
  }
}

function mergeWith(target, source) {
  const _ = require('lodash');
  const mergeArrayUnion = (a, b) => Array.isArray(a) ? _.union(a, b) : undefined;
  _.mergeWith(target, source, mergeArrayUnion);
  return target;
}

function mergeCompose(composePartials) {
  let dockerCompose = {};
  composePartials.forEach((c) => mergeWith(dockerCompose, c));
  return dockerCompose;
}

function buildCompose(descs, dockerComposePatch, composePartials) {
  console.log('create docker-compose.yml');
  const dockerCompose = mergeCompose(composePartials);
  const services = dockerCompose.services;
  // link the api server types to the web types and server to the api
  const web = descs.filter((d) => d.type === 'web').map((d) => d.label);
  const api = descs.filter((d) => d.type === 'api').map((d) => d.label);
  api.forEach((s) => {
    web.forEach((w) => {
      services[w].links = services[w].links || [];
      services[w].links.push(`${s}:api`);
    });
  });
  descs.filter((d) => d.type === 'service').forEach((s) => {
    api.forEach((w) => {
      services[w].links = services[w].links || [];
      services[w].links.push(`${s.label}:${s.name}`);
    });
  });

  if (services._host) {
    // inline _host to apis
    const host = services._host;
    delete services._host;
    api.forEach((s) => {
      services[s] = mergeCompose([host, services[s]]);
    });
  }

  Object.keys(dockerComposePatch.services).forEach((service) => {
    if (services[service] !== undefined) {
      console.log(`patch generated docker-compose file for ${service}`);
      mergeWith(services[service], dockerComposePatch.services[service]);
    }
  });

  const yaml = require('yamljs');
  return fs.writeFileAsync('build/docker-compose.yml', yaml.stringify(dockerCompose, 100, 2))
    .then(() => dockerCompose);
}

function pushImages(images) {
  const dockerRepository = argv.pushTo;
  if (!dockerRepository) {
    return null;
  }
  console.log('push docker images');

  const tags = [];
  if (!argv.noDefaultTags) {
    tags.push(...images.map((image) => ({image, tag: `${dockerRepository}/${image}`})));
  }
  if (argv.pushExtra) { // push additional custom prefix without the version
    tags.push(...images.map((image) => ({
      image,
      tag: `${dockerRepository}/${image.substring(0, image.lastIndexOf(':'))}:${argv.pushExtra}`
    })));
  }
  if (tags.length === 0) {
    return Promise.resolve([]);
  }
  return Promise.all(tags.map((tag) => docker('.', `tag ${tag.image} ${tag.tag}`)))
    .then(() => Promise.all(tags.map((tag) => docker('.', `push ${tag.tag}`))));
}

function loadPatchFile() {
  if (!fs.existsSync('./docker-compose-patch.yaml')) {
    return {services: {}};
  }
  const content = fs.readFileSync('./docker-compose-patch.yaml');
  const yaml = require('yamljs');
  const r = yaml.parse(content.toString());
  if (!r.services) {
    r.services = {};
  }
  return r;
}

if (require.main === module) {
  if (argv.skipTests) {
    // if skipTest option is set, skip tests
    console.log(chalk.blue('skipping tests'));
    env.PHOVEA_SKIP_TESTS = true;
  }
  if (argv.quiet) {
    // if skipTest option is set, skip tests
    console.log(chalk.blue('will try to keep my mouth shut...'));
  }
  const descs = require('./phovea_product.json');
  const dockerComposePatch = loadPatchFile();
  const singleService = descs.length === 1 && (argv.forceLabel === undefined);
  const productName = pkg.name.replace('_product', '');

  fs.emptyDirAsync('build')
    .then(dockerRemoveImages.bind(this, productName))
    // move my own .yo-rc.json to avoid a conflict
    .then(fs.renameAsync('.yo-rc.json', '.yo-rc_tmp.json'))
    .then(() => {
      const buildOne = (d, i) => {
        d.additional = d.additional || []; // default values
        d.data = d.data || [];
        d.name = d.name || fromRepoUrl(d.repo);
        d.label = d.label || d.name;
        if (dockerComposePatch.services[d.label] && dockerComposePatch.services[d.label].image) {
          // use a different base image to build the item
          d.baseImage = dockerComposePatch.services[d.label].image;
          delete dockerComposePatch.services[d.label].image;
        }
        if (singleService) {
          d.image = `${productName}:${pkg.version}`;
        } else {
          d.image = `${productName}/${d.label}:${pkg.version}`;
        }
        let wait = buildImpl(d, './tmp' + i);
        wait.catch((error) => {
          d.error = error;
          console.error('ERROR building ', d, error);
        });
        return wait;
      };
      if (argv.serial) {
        let r = Promise.resolve([]);
        for (let i = 0; i < descs.length; ++i) {
          r = r.then((arr) => buildOne(descs[i], i).then((f) => arr.concat(f)));
        }
        return r;
      }
      return Promise.all(descs.map(buildOne));
    })
    .then((composeFiles) => buildCompose(descs, dockerComposePatch, composeFiles.filter((d) => Boolean(d))))
    .then(() => pushImages(descs.filter((d) => !d.error).map((d) => d.image)))
    .then(() => fs.renameAsync('.yo-rc_tmp.json', '.yo-rc.json'))
    .then(() => {
      console.log(chalk.bold('summary: '));
      const maxLength = Math.max(...descs.map((d) => d.name.length));
      descs.forEach((d) => console.log(` ${d.name}${'.'.repeat(3 + (maxLength - d.name.length))}` + (d.error ? chalk.red('ERROR') : chalk.green('SUCCESS'))));
      const anyErrors = descs.some((d) => d.error);
      if (anyErrors) {
        process.exit(1);
      }
    }).catch((error) => {
      console.error('ERROR extra building ', error);
      process.exit(1);
    });
}

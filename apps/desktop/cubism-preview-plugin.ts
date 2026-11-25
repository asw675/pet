import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { normalizePath, searchForWorkspaceRoot, type Plugin } from 'vite';

const moduleName = 'virtual:pet-desktop-cubism-sdk';
const resolvedModule = '\0' + moduleName;
const route = '/__pet_desktop_cubism_preview/';

function inside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath !== '..' && !relativePath.startsWith('../') && !relativePath.startsWith('..\\') && !isAbsolute(relativePath);
}

function readLocalSdkFile(root: string, name: string, maxBytes: number): Buffer {
  const actual = realpathSync(resolve(root, name));
  const stat = statSync(actual);
  if (!inside(root, actual) || !stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
    throw new Error('Invalid file in local Cubism SDK');
  }
  return readFileSync(actual);
}

export function cubismPreviewPlugin(): Plugin {
  let frameworkSource: string | undefined;
  const endpoints = new Map<string, { body: Buffer; type: string }>();
  return {
    name: 'pet-desktop-cubism-local-preview',
    config(config, env) {
      frameworkSource = undefined;
      endpoints.clear();
      const sdk = process.env.PET_DESKTOP_CUBISM_WEB_SDK;
      // The release/CI module is always an inert stub, even when a developer
      // still has the SDK variable set in the same PowerShell session.
      if (env.command !== 'serve' || !sdk) return undefined;
      const pinned = process.env.PET_DESKTOP_CUBISM_CORE_SHA256?.toLowerCase();
      if (!isAbsolute(sdk) || !pinned || !/^[0-9a-f]{64}$/u.test(pinned)) {
        throw new Error('Local Cubism preview requires an absolute SDK path and a pinned Core SHA-256');
      }
      const root = realpathSync(sdk);
      const core = readLocalSdkFile(root, 'Core/live2dcubismcore.js', 32 * 1024 * 1024);
      if (createHash('sha256').update(core).digest('hex') !== pinned) {
        throw new Error('Local Cubism Core SHA-256 does not match the configured pin');
      }
      const framework = realpathSync(resolve(root, 'Framework'));
      frameworkSource = realpathSync(resolve(framework, 'src'));
      if (!inside(root, frameworkSource) || !statSync(frameworkSource).isDirectory()) throw new Error('Invalid Cubism Framework directory');
      const shaders = 'Framework/Shaders/WebGL';
      const entries = readdirSync(resolve(root, shaders), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && /^[a-z0-9]+\.(?:vert|frag)$/u.test(entry.name)) {
          endpoints.set(route + 'shaders/' + entry.name,
            { body: readLocalSdkFile(root, shaders + '/' + entry.name, 256 * 1024), type: 'text/plain' });
        }
      }
      if (!endpoints.has(route + 'shaders/vertshadersrc.vert') || !endpoints.has(route + 'shaders/fragshadersrcpremultipliedalphablend.frag')) {
        throw new Error('Local Cubism preview requires the Cubism Web R5 shaders');
      }
      endpoints.set(route + 'live2dcubismcore.js', { body: core, type: 'text/javascript' });
      return { server: { host: '127.0.0.1', fs: {
        allow: [searchForWorkspaceRoot(config.root ?? process.cwd()), frameworkSource],
      } } };
    },
    configureServer(server) {
      if (!frameworkSource) return;
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?')[0];
        if (request.method !== 'GET' || !pathname?.startsWith(route)) return next();
        const item = endpoints.get(pathname);
        if (!item) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', item.type);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Cache-Control', 'no-store');
        response.end(item.body);
      });
    },
    transformIndexHtml(html, context) {
      if (!frameworkSource || !normalizePath(context.filename ?? '').endsWith('/pet/index.html')) return html;
      return html.replace("script-src 'self';", "script-src 'self' 'wasm-unsafe-eval';");
    },
    resolveId(id) { return id === moduleName ? resolvedModule : undefined; },
    load(id) {
      if (id !== resolvedModule) return undefined;
      if (!frameworkSource) return 'export const preview = null;';
      const path = (file: string) => JSON.stringify('/@fs/' + normalizePath(resolve(frameworkSource!, file + '.ts')));
      return `
export const preview = {
  core: ${JSON.stringify(route + 'live2dcubismcore.js')},
  shaders: ${JSON.stringify(route + 'shaders/')},
  async load() {
    const [framework, model, renderer, shader, matrix, physics, pose, motion, manager, expression, expressionManager] = await Promise.all([
      import(${path('live2dcubismframework')}), import(${path('model/cubismmoc')}),
      import(${path('rendering/cubismrenderer_webgl')}), import(${path('rendering/cubismshader_webgl')}),
      import(${path('math/cubismmatrix44')}), import(${path('physics/cubismphysics')}),
      import(${path('effect/cubismpose')}), import(${path('motion/cubismmotion')}),
      import(${path('motion/cubismmotionmanager')}), import(${path('motion/cubismexpressionmotion')}),
      import(${path('motion/cubismexpressionmotionmanager')})
    ]);
    return {
      framework: framework.CubismFramework, moc: model.CubismMoc, Renderer: renderer.CubismRenderer_WebGL,
      shaders: shader.CubismShaderManager_WebGL, Matrix: matrix.CubismMatrix44,
      physics: physics.CubismPhysics, pose: pose.CubismPose, motion: motion.CubismMotion,
      MotionManager: manager.CubismMotionManager, expression: expression.CubismExpressionMotion,
      ExpressionManager: expressionManager.CubismExpressionMotionManager,
    };
  },
};`;
    },
  };
}

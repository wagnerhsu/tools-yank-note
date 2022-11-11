import parseAuthor from 'parse-author'
import semver from 'semver'
import pako from 'pako'
import untar from 'js-untar'
import { getLogger, path } from '@fe/utils'
import * as api from '@fe/support/api'
import { getActionHandler } from '@fe/core/action'
import type { Extension, ExtensionCompatible, ExtensionLoadStatus, RegistryHostname } from '@fe/types'
import * as i18n from '@fe/services/i18n'
import * as theme from '@fe/services/theme'
import * as view from '@fe/services/view'
import { triggerHook } from '@fe/core/hook'
import { FLAG_DEMO } from '@fe/support/args'

const logger = getLogger('extension')

const loaded = new Map<string, ExtensionLoadStatus>()

export const registries: RegistryHostname[] = [
  'registry.npmjs.org',
  'registry.npmmirror.com',
]

function shouldLoad (extension: Extension) {
  return extension.enabled && extension.compatible
}

function changeRegistryOrigin (hostname: RegistryHostname, url: string) {
  const _url = new URL(url)
  _url.hostname = hostname
  return _url.toString()
}

export function getExtensionPath (id: string, ...paths: string[]) {
  return path.join(id.replace(/\//g, '$'), ...paths)
}

export function getInstalledExtensionFileUrl (id: string, filename: string) {
  if (/https?:\/\//.test(filename)) {
    return filename
  }

  return path.join('/extensions', getExtensionPath(id, filename))
}

export function getLoadStatus (id: string): ExtensionLoadStatus {
  return loaded.get(id) || { version: undefined, themes: false, plugin: false, style: false, activationTime: 0 }
}

export function getCompatible (engines?: { 'yank-note': string }): ExtensionCompatible {
  if (!engines || !engines['yank-note']) {
    return { value: false, reason: 'Not yank note extension.' }
  }

  const engineVersion = __APP_VERSION__

  const value = semver.satisfies(engineVersion, engines['yank-note'])

  return {
    value,
    reason: value ? 'Compatible' : `Need Yank Note [${engines['yank-note']}].`,
  }
}

export function readInfoFromJson (json: any): Omit<Extension, 'installed'> | null {
  if (!json || !json.name || !json.version) {
    return null
  }

  const language = i18n.getCurrentLanguage().toUpperCase()

  return {
    id: json.name,
    version: json.version,
    license: typeof json.license === 'string' ? json.license : '',
    author: typeof json.author === 'string'
      ? parseAuthor(json.author) || { name: '' }
      : json.author || { name: '' },
    themes: json.themes || [],
    requirements: json.requirements || {},
    main: json.main || '',
    style: json.style || '',
    icon: json.icon || '',
    readmeUrl: json.readmeUrl || '',
    changelogUrl: json.changelogUrl || '',
    displayName: json[`displayName_${language}`] || json.displayName || json.name,
    description: json[`description_${language}`] || json.description || '',
    compatible: getCompatible(json.engines),
    origin: json.origin || 'unknown',
    dist: json.dist || { tarball: '', unpackedSize: 0 },
    homepage: json.homepage || '',
  }
}

export async function getInstalledExtension (id: string): Promise<Extension | null> {
  let json

  try {
    json = await api.fetchHttp(getInstalledExtensionFileUrl(id, 'package.json'))
    if (!json.name || !json.version) {
      throw new Error('Invalid extension package.json')
    }
  } catch (error) {
    logger.error(error)
    return null
  }

  const info = readInfoFromJson(json)
  if (info) {
    return { ...info, installed: true, origin: FLAG_DEMO ? 'registry' : 'unknown' }
  }

  return null
}

export async function getInstalledExtensions () {
  const extensions: Extension[] = []
  for (const item of await api.fetchInstalledExtensions()) {
    const info = await getInstalledExtension(item.id)
    if (info) {
      if (info.id !== item.id) {
        logger.warn(`Extension ${item.id} has been installed but package.json is not valid.`)
        continue
      }

      extensions.push({
        ...info,
        installed: true,
        enabled: item.enabled && info.compatible.value,
        icon: getInstalledExtensionFileUrl(info.id, info.icon),
        readmeUrl: getInstalledExtensionFileUrl(info.id, 'README.md'),
        changelogUrl: getInstalledExtensionFileUrl(info.id, 'CHANGELOG.md'),
        isDev: item.isDev,
      })
    }
  }

  return extensions
}

export async function getRegistryExtensions (registry: RegistryHostname = 'registry.npmjs.org'): Promise<Extension[]> {
  logger.debug('getRegistryExtensions', registry)

  const registryUrl = `https://${registry}/yank-note-registry`
  const registryJson = await api.proxyRequest(registryUrl, { timeout: 5000 }).then(r => r.json())
  const latest = registryJson['dist-tags'].latest
  const tarballUrl = changeRegistryOrigin(registry, registryJson.versions[latest].dist.tarball)

  const extensions = await api.proxyRequest(tarballUrl, { timeout: 5000 })
    .then(r => r.arrayBuffer())
    .then(data => pako.inflate(new Uint8Array(data)))
    .then(arr => arr.buffer)
    .then(buffer => untar(buffer))
    .then(files => files.find((x: any) => x.name === 'package/index.json'))
    .then(file => new TextDecoder('utf-8').decode(file.buffer))
    .then(JSON.parse)

  return extensions.map(readInfoFromJson)
}

export function showManager (id?: string) {
  getActionHandler('extension.show-manager')(id)
}

export async function enable (extension: Extension) {
  await api.enableExtension(extension.id)
  extension.enabled = true
  await load(extension)
  triggerHook('EXTENSION_READY', { extensions: [extension] })
}

export async function disable (extension: Pick<Extension, 'id'>) {
  await api.disableExtension(extension.id)
}

export async function uninstall (extension: Pick<Extension, 'id'>) {
  await api.uninstallExtension(extension.id)
}

export async function abortInstallation () {
  await api.abortExtensionInstallation()
}

export async function install (extension: Extension, registry: RegistryHostname = 'registry.npmjs.org') {
  const url = extension.dist.tarball
  if (!url) {
    throw new Error('No dist url')
  }

  await api.installExtension(extension.id, changeRegistryOrigin(registry, url))
  await enable(extension)
}

async function load (extension: Extension) {
  if (shouldLoad(extension)) {
    logger.debug('load', extension.id)
    const loadStatus: ExtensionLoadStatus = loaded.get(extension.id) || { themes: false, plugin: false, style: false, activationTime: 0 }

    loadStatus.version = extension.version

    let scriptStartTime = performance.now()
    let scriptEndTime = scriptStartTime
    let pluginPromise: Promise<void> | undefined

    const main = extension?.main
    if (!loadStatus.plugin && main && (main.endsWith('.js') || main.endsWith('.mjs'))) {
      pluginPromise = new Promise((resolve, reject) => {
        const script = window.document.createElement('script')
        script.src = getInstalledExtensionFileUrl(extension.id, main)
        script.defer = true

        // support esm
        if (main.endsWith('.mjs')) {
          script.type = 'module'
        }

        script.onload = () => {
          resolve()
          scriptEndTime = performance.now()
          script.onload = null
        }

        script.onerror = (error) => {
          reject(error)
          scriptEndTime = performance.now()
          script.onerror = null
        }

        window.document.body.appendChild(script)
        setTimeout(() => {
          scriptStartTime = performance.now()
        }, 0)
      })
    }

    const style = extension?.style
    if (!loadStatus.style && style && style.endsWith('.css')) {
      const href = getInstalledExtensionFileUrl(extension.id, style)

      // add style to workbench
      theme.addStyleLink(href)

      // also add style to preview iframe
      view.addStyleLink(href)

      loadStatus.style = true
    }

    if (!loadStatus.themes && extension?.themes && extension.themes.length) {
      extension.themes.forEach(style => {
        theme.registerThemeStyle({
          from: 'extension',
          name: `[${extension.id}]: ${style.name}`,
          css: `extension:${getExtensionPath(extension.id, style.css)}`,
        })
      })
      loadStatus.themes = true
    }

    if (pluginPromise) {
      try {
        await pluginPromise
      } catch (error) {
        console.warn(`Load extension error [${extension.id}]`, error)
      } finally {
        loadStatus.plugin = true
        loadStatus.activationTime = scriptEndTime - scriptStartTime
      }
    }

    loaded.set(extension.id, loadStatus)
  }
}

let initialized = false

export function getInitialized () {
  return initialized
}

/**
 * Initialization extension system
 */
export async function init () {
  logger.debug('init')

  const extensions = (await getInstalledExtensions()).filter(shouldLoad)

  for (const extension of extensions) {
    await load(extension)
  }

  initialized = true
  triggerHook('EXTENSION_READY', { extensions })
}

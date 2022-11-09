import { slugify } from 'transliteration'
import filenamify from 'filenamify/browser'
import type { Doc } from '@fe/types'
import * as api from '@fe/support/api'
import { getSetting } from './setting'
import { FLAG_DEMO } from '@fe/support/args'
import { binMd5, quote, fileToBase64URL, getLogger, removeQuery } from '@fe/utils'
import { basename, resolve, extname, dirname, relative, isBelongTo } from '@fe/utils/path'
import { dayjs } from '@fe/context/lib'
import { useModal } from '@fe/support/ui/modal'
import { useToast } from '@fe/support/ui/toast'
import { isElectron, isWindows } from '@fe/support/env'
import { t } from './i18n'

const logger = getLogger('service-base')

/**
 * Get document attachment url
 * @param doc
 * @param opts
 * @returns
 */
export function getAttachmentURL (doc: Doc, opts: { origin: boolean } = { origin: false }) {
  if (doc.type !== 'file') {
    throw new Error('Document type must be file')
  }

  const fileName = removeQuery(doc.name)
  const repo = doc.repo
  const filePath = doc.path
  const uri = `/api/attachment/${encodeURIComponent(fileName)}?repo=${repo}&path=${encodeURIComponent(filePath)}`

  if (opts.origin) {
    return `${window.location.origin}${uri}`
  }

  return uri
}

/**
 * Upload a file.
 * @param file
 * @param belongDoc belong document
 * @param name filename
 * @returns
 */
export async function upload (file: File, belongDoc: Pick<Doc, 'repo' | 'path'>, name?: string) {
  if (FLAG_DEMO) {
    return Promise.resolve(URL.createObjectURL(file))
  }

  const fileBase64Url = await fileToBase64URL(file)

  const filename = name || binMd5(fileBase64Url).substr(0, 8) + extname(file.name)
  const parentName = basename(belongDoc.path)
  const parentPath = dirname(belongDoc.path)
  const assetsPathType = getSetting('assets.path-type', 'auto')
  const assetsDir = getSetting('assets-dir', './FILES/{docName}')
    .replaceAll('{docSlug}', parentName.startsWith('.') ? 'upload' : slugify(parentName))
    .replaceAll('{docName}', parentName.startsWith('.') ? 'upload' : filenamify(parentName))
    .replaceAll('{docBasename}', parentName.startsWith('.') ? 'upload' : filenamify(parentName).replace(/\.md$/i, ''))
    .replaceAll('{date}', dayjs().format('YYYY-MM-DD'))

  const path: string = resolve(parentPath, assetsDir, filename)

  logger.debug('upload', belongDoc, file, path)

  await api.upload(belongDoc.repo, fileBase64Url, path)

  if (
    assetsPathType === 'relative' ||
    (assetsPathType === 'auto' && isBelongTo(parentPath, path))
  ) {
    return './' + relative(parentPath, path)
  }

  return path
}

/**
 * Input password.
 * @param title
 * @param hint
 * @param throwError
 * @returns
 */
export async function inputPassword (title: string, hint: string, throwError = false) {
  const password = await useModal().input({ title, type: 'password', hint })
  if (!password) {
    const msg = t('no-password')
    if (throwError) {
      throw new Error(msg)
    } else {
      useToast().show('warning', msg)
    }
  }

  return password || ''
}

/**
 * open an external uri
 * @param uri
 */
export async function openExternal (uri: string) {
  await api.rpc(`require('electron').shell.openExternal(${quote(uri)})`)
}

/**
 * open a path
 * @param path
 */
export async function openPath (path: string) {
  await api.rpc(`require('electron').shell.openPath(${quote(path)})`)
}

/**
 * show item in folder
 * @param path
 */
export async function showItemInFolder (path: string) {
  if (isWindows) {
    path = path.replaceAll('/', '\\')
  }

  await api.rpc(`require('electron').shell.showItemInFolder(${quote(path)})`)
}

/**
 * Trash item
 * @param path
 */
export async function trashItem (path: string) {
  if (isWindows) {
    path = path.replaceAll('/', '\\')
  }

  await api.rpc(`require('electron').shell.trashItem(${quote(path)})`)
}

/**
 * Reload main window main page
 */
export async function reloadMainWindow () {
  if (isElectron) {
    await api.rpc("require('./action').getAction('reload-main-window')()")
  } else {
    location.reload()
  }
}

/**
 * get repo by name
 * @param name
 * @returns
 */
export function getRepo (name: string) {
  return (getSetting('repos') || []).find(x => x.name === name)
}

export async function readFromClipboard (): Promise<Record<string, any>>
export async function readFromClipboard (callback: (type: string, getType: (type: string) => Promise<Blob>) => Promise<void>): Promise<void>
export async function readFromClipboard (callback?: (type: string, getType: (type: string) => Promise<Blob>) => Promise<void>): Promise<void | Record<string, any>> {
  const permissionResult = await navigator.permissions.query({ name: 'clipboard-read' as any })

  if (permissionResult.state === 'denied') {
    useToast().show('warning', t('need-clipboard-permission'))
    return
  }

  const items: any = await (navigator.clipboard as any).read()

  const result: Record<string, any> = {}
  for (const item of items) {
    for (const type of (item.types as string[])) {
      if (callback) {
        await callback(type, item.getType.bind(item))
      } else {
        result[type] = await item.getType(type)
      }
    }
  }

  if (callback) {
    return
  }

  return result
}

export async function writeToClipboard (type: string, value: any) {
  const result = await navigator.permissions.query({ name: 'clipboard-write' as any })

  if (result.state === 'denied') {
    useToast().show('warning', t('need-clipboard-permission'))
    return
  }

  return (navigator.clipboard as any).write([new (window as any).ClipboardItem({
    [type]: new Blob([value], { type })
  })])
}

/**
 * Get Server Timestamp
 * @returns timestamp in ms
 */
export async function getServerTimestamp () {
  const date = (await api.proxyRequest('https://www.baidu.com/')).headers.get('x-origin-date')
  return dayjs(date || undefined).valueOf()
}

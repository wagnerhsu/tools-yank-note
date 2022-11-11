import StateCore from 'markdown-it/lib/rules_core/state_core'
import Token from 'markdown-it/lib/token'
import { Plugin } from '@fe/context'
import store from '@fe/support/store'
import { removeQuery, sleep } from '@fe/utils'
import { isElectron } from '@fe/support/env'
import { useToast } from '@fe/support/ui/toast'
import { DOM_ATTR_NAME, DOM_CLASS_NAME } from '@fe/support/args'
import { basename, dirname, join, resolve } from '@fe/utils/path'
import { switchDoc } from '@fe/services/document'
import { getAttachmentURL, getRepo, openExternal, openPath } from '@fe/services/base'
import { getRenderIframe } from '@fe/services/view'

async function getElement (id: string) {
  id = id.replaceAll('%28', '(').replaceAll('%29', ')')

  const document = (await getRenderIframe()).contentDocument!

  const _find = (id: string) => document.getElementById(id) ||
    document.getElementById(decodeURIComponent(id)) ||
    document.getElementById(encodeURIComponent(id)) ||
    document.getElementById(id.replace(/^h-/, '')) ||
    document.getElementById(decodeURIComponent(id.replace(/^h-/, ''))) ||
    document.getElementById(encodeURIComponent(id.replace(/^h-/, '')))

  return _find(id) || _find(id.toUpperCase())
}

function getAnchorElement (target: HTMLElement) {
  let cur: HTMLElement | null = target
  while (cur && cur.tagName !== 'A' && cur.tagName !== 'ARTICLE') {
    cur = cur.parentElement
  }

  return cur?.tagName === 'A' ? <HTMLAnchorElement>cur : null
}

function handleLink (link: HTMLAnchorElement): boolean {
  const { currentFile } = store.state
  if (!currentFile) {
    return false
  }

  const { repo: fileRepo, path: filePath } = currentFile

  // open attachment in os
  const href = link.getAttribute('href') || ''

  if (!href.trim()) {
    useToast().show('warning', 'Link is empty.')
    return true
  } else if (/^(http:|https:|ftp:)\/\//i.test(href)) { // external link
    if (isElectron) {
      openExternal(link.href)
      return true
    } else {
      return false
    }
  } else if (/^file:\/\//i.test(href)) {
    openPath(decodeURI(href.replace(/^file:\/\//i, '')))
    return true
  } else if (link.classList.contains(DOM_CLASS_NAME.MARK_OPEN)) {
    const path = link.getAttribute(DOM_ATTR_NAME.ORIGIN_HREF) || decodeURI(href)

    const basePath = path.startsWith('/')
      ? (getRepo(fileRepo)?.path || '/')
      : dirname(currentFile.absolutePath || '/')

    openPath(join(basePath, path))
    return true
  } else { // relative link
    // better scrollIntoView
    const scrollIntoView = async (el: HTMLElement) => {
      el.scrollIntoView()
      // retain 60 px for better view.
      const contentWindow = (await getRenderIframe()).contentWindow!
      contentWindow.scrollBy(0, -60)

      // highlight element
      el.classList.add(DOM_CLASS_NAME.PREVIEW_HIGHLIGHT)
      await sleep(1000)
      el.classList.remove(DOM_CLASS_NAME.PREVIEW_HIGHLIGHT)
    }

    if (/(\.md$|\.md#)/.test(href)) { // markdown file
      const tmp = decodeURI(href).split('#')

      let path = tmp[0]
      if (!path.startsWith('/')) { // to absolute path
        path = join(dirname(filePath || ''), path)
      }

      switchDoc({
        path,
        name: basename(path),
        repo: fileRepo,
        type: 'file'
      }).then(async () => {
        const hash = tmp.slice(1).join('#')
        // jump anchor
        if (hash) {
          await sleep(50)
          const el = await getElement(hash)

          if (el) {
            await sleep(0)
            scrollIntoView(el)

            // reveal editor lint when click heading
            if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(el.tagName)) {
              el.click()
            }
          }
        }
      })

      return true
    } else if (href && href.startsWith('#')) { // for anchor
      getElement(href.replace(/^#/, '')).then(el => {
        el && scrollIntoView(el)
      })
      return true
    } else {
      return false
    }
  }
}

function convertLink (state: StateCore) {
  const tags = ['audio', 'img', 'source', 'video', 'track', 'a']

  const { repo, path, name } = state.env.file || {}
  if (!repo || !path || !name) {
    return false
  }

  const link = (token: Token) => {
    const isAnchor = token.tag === 'a'
    const attrName = isAnchor ? 'href' : 'src'
    const attrVal = decodeURIComponent(token.attrGet(attrName) || '')
    if (!attrVal) {
      return
    }

    if (/^[^:]*:/.test(attrVal) || attrVal.startsWith('//')) { // xxx:
      return
    }

    const basePath = dirname(path)
    const fileName = basename(removeQuery(attrVal))

    if (isAnchor) {
      // keep markdown file.
      if (fileName.endsWith('.md')) {
        return
      }

      // keep anchor hash.
      if (attrVal.indexOf('#') > -1) {
        return
      }

      // open other file in os
      token.attrJoin('class', DOM_CLASS_NAME.MARK_OPEN)
    } else {
      token.attrSet(DOM_ATTR_NAME.LOCAL_IMAGE, 'true')
    }

    const originAttr = isAnchor ? DOM_ATTR_NAME.ORIGIN_HREF : DOM_ATTR_NAME.ORIGIN_SRC
    token.attrSet(originAttr, attrVal)

    const originPath = removeQuery(attrVal)

    const targetUri = getAttachmentURL({
      type: 'file',
      repo,
      path: resolve(basePath, originPath),
      name: fileName,
    })

    token.attrSet(attrName, targetUri)
  }

  const convert = (tokens: Token[]) => {
    tokens.forEach(token => {
      if (tags.includes(token.tag)) {
        link(token)
      }

      if (token.children) {
        convert(token.children)
      }
    })
  }

  convert(state.tokens)

  return true
}

export default {
  name: 'markdown-link',
  register: (ctx) => {
    let baseUrl = location.origin + location.pathname.substring(0, location.pathname.lastIndexOf('/')) + '/'

    // replace localhost to ip, somtimes resolve localhost take too much time on windows.
    if (/^(http|https):\/\/localhost/i.test(baseUrl)) {
      baseUrl = baseUrl.replace(/localhost/i, '127.0.0.1')
    }

    ctx.registerHook('VIEW_ON_GET_HTML_FILTER_NODE', async ({ node, options }) => {
      // local image
      const srcAttr = node.getAttribute('src')
      if (srcAttr && node.getAttribute(DOM_ATTR_NAME.LOCAL_IMAGE)) {
        if (options.inlineLocalImage || options.uploadLocalImage) {
          try {
            const originSrc = node.getAttribute(DOM_ATTR_NAME.ORIGIN_SRC)
            const res: Response = await ctx.api.fetchHttp(srcAttr)
            const fileName = originSrc ? ctx.utils.path.basename(removeQuery(originSrc)) : 'img'
            const file = new File(
              [await res.blob()],
              fileName,
              { type: ctx.lib.mime.getType(fileName) || undefined }
            )

            let url: string | undefined
            if (options.inlineLocalImage) {
              url = await ctx.utils.fileToBase64URL(file)
            } else if (options.uploadLocalImage) {
              url = await ctx.action.getActionHandler('plugin.image-hosting-picgo.upload')(file)
            }

            if (url) {
              node.setAttribute('src', url)
              node.removeAttribute(DOM_ATTR_NAME.ORIGIN_SRC)
            }
          } catch (error) {
            console.log(error)
          }
        } else {
          node.setAttribute('src', `${baseUrl}${srcAttr}`)
        }
      }

      const originSrc = node.getAttribute(DOM_ATTR_NAME.ORIGIN_SRC)
      if (originSrc) {
        node.setAttribute('src', originSrc)
        node.removeAttribute(DOM_ATTR_NAME.ORIGIN_SRC)
      }
    })

    ctx.registerHook('VIEW_ELEMENT_CLICK', async ({ e }) => {
      const anchorTarget = getAnchorElement(<HTMLElement>e.target)

      if (anchorTarget) {
        if (handleLink(anchorTarget)) {
          e.preventDefault()
          e.stopPropagation()
          return true
        } else {
          return true
        }
      }

      return false
    })

    ctx.markdown.registerPlugin(md => {
      md.core.ruler.push('convert_relative_path', convertLink)
      md.renderer.rules.link_open = (tokens, idx, options, _, slf) => {
        if (tokens[idx].attrIndex('target') < 0) {
          tokens[idx].attrPush(['target', '_blank'])
        }

        return slf.renderToken(tokens, idx, options)
      }

      // skip link validate
      md.validateLink = () => true
    })

    ctx.view.tapContextMenus((menus, e) => {
      const target = e.target as HTMLLinkElement
      const parent = target.parentElement
      const link = target.getAttribute('href') || ''
      const text = target.innerText

      if (
        target.tagName === 'A' &&
        parent?.dataset?.sourceLine &&
        (text === link || text === decodeURI(link)) &&
        /^http:\/\/|^https:\/\//.test(link)
      ) {
        menus.push({
          id: 'plugin.markdown-link.transform-link',
          type: 'normal',
          label: ctx.i18n.t('markdown-link.convert-to-titled-link'),
          onClick: async () => {
            try {
              ctx.ui.useToast().show('info', 'Loading……', 0)
              const res = await ctx.api.proxyRequest(target.href, { timeout: 10000 }).then(r => r.text())
              const match = res.match(/<title[^>]*>([^<]*)<\/title>/si) || []
              const title = ctx.lib.lodash.unescape(match[1] || '').trim()

              if (!title) {
                throw new Error('No title')
              }

              const lineStart = parseInt(parent.getAttribute(DOM_ATTR_NAME.SOURCE_LINE_START) || '0')
              const lineEnd = parseInt(parent.getAttribute(DOM_ATTR_NAME.SOURCE_LINE_END) || '0') - 1

              const content = ctx.editor.getLinesContent(lineStart, lineEnd)
                .replace(new RegExp(`(?<!\\()<?${link}>?(?!\\))`, 'i'), `[${title}](${link})`)

              ctx.editor.replaceLines(lineStart, lineEnd, content)
              ctx.ui.useToast().hide()
            } catch (error: any) {
              console.error(error)
              ctx.ui.useToast().show('warning', error.message)
            }
          }
        })
      }
    })
  }
} as Plugin

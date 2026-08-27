const { html, css, toSafeUrl } = Utils
const { initComponent } = Components

const CoverColumn = (data) => initComponent({
  content: () => html`
    <div id="third-column-add-entry">
      <img
        id="external-img"
        src="${coverUrl(data)}"
        alt="${data?.commonMetadata.englishTranslatedTitle ?? ''} cover"
      />
      ${linkableUrls(data).length > 0
        ? html`
          <div id="external-links">
            <b>External links</b><br>
            ${linkableUrls(data).map(({ name, url }) => html`<a href="${url}">${name}</a><br>`)}
          </div>
        `
          : html`<div style="margin-top: 25px;">Entry created from scratch.</div>`
      }
    </div>
  `,
  style: () => css`
    #third-column-add-entry {
      flex-shrink: 4;
      text-align: center;
      max-width: 200px;
    }
    #external-img {
      max-width: 100%;
      margin-top: 50px;
      border-radius: 10px;
      box-shadow: 2px 2px 5px rgba(0,0,0,.5)
    }
    #external-links {
      margin-top: 25px;
    }
  `
})

Components.List.CoverColumn = CoverColumn

///////////////////////////////////////////////////////////////////////////////

/**
 * The cover, or the placeholder. An `imageUrl` is metadata or an override the
 * owner typed, so its scheme is checked before it goes anywhere near a `src`
 * — escaping does nothing to `javascript:`, and this field is the one on the
 * form that invites a url to be pasted into it.
 */
const coverUrl = (data) =>
  toSafeUrl(data?.overrides?.imageUrl ?? data?.commonMetadata?.imageUrl) ||
  '/img/mawaru.png'

/**
 * The external links worth drawing: a link to a scheme we would not follow is
 * dropped rather than rendered dead, the same reading `titleFormatter` takes.
 */
const linkableUrls = (data) =>
  (data?.commonMetadata?.externalUrls ?? [])
    .map(({ name, url }) => ({ name, url: toSafeUrl(url) }))
    .filter(({ url }) => url)

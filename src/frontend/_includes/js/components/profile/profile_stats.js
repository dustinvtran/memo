const { entryTypes, getStats } = Netlify
const { col } = Tables
const { typeToTitle } = Conversions
const { html, css, timeAgo, dateTime, escapeHtml } = Utils
const { initComponent, WithRemoteData } = Components
const { Tabbed } = Components.UI

const ProfileStats = (username) => initComponent({
  content: ({ include }) => html`
      ${include(WithRemoteData({
        remoteData: getStats(username),
        component: (stats) => initComponent({
          content: ({ include }) => html`
            ${include(Tabbed(
              "Stats",
              [
                { title: "Stats per category", component: SubStats(username, stats) },
                { title: "Global stats", component: GlobalStats(stats) },
              ]
              ))}
            ${include(StatsFreshness(stats.updatedDate))}
          `
        })
      }))}
  `,
  initializer: () => {
    // The charts below are the only thing on this site that wants ApexCharts,
    // and they cannot draw before the stats have arrived either — so the 862 KB
    // starts here, alongside the request for the numbers, rather than after it.
    // All five of them then await this one load.
    //
    // The result is dropped: `drawChart` is what waits for it and what reports
    // it failing. This `catch` is here so that a failure is not *also* an
    // unhandled rejection.
    loadApexCharts().catch(() => undefined)
  }
})


Components.Profile.ProfileStats = ProfileStats

///////////////////////////////////////////////////////////////////////////////

const SubStats = (username, stats) => initComponent({
  content: ({ include }) => html`
    <div style="display: flex; flex-wrap: wrap; justify-content: space-between;">
      ${include(
        entryTypes.map(type => ProfileStatsOfType(username, type, stats))
      )}
    </div>
  `
})

const ProfileStatsOfType = (username, type, stats) => initComponent({
  content: ({ id, include }) => html`
    <div class="profile-stats">
      <h3><a href="/${type}/${escapeHtml(encodeURIComponent(username))}">${typeToTitle[type]}</a></h3>
      <div id=${id}></div>
      ${include(AdditionalStats(stats.scores[type]))}
    </div>
  `,
  style: () => css`
    .profile-stats {
      width: 48%;
    }
    .profile-stats h3 a {
      position: relative;
      z-index: 2;
    }
    .profile-stats .apexcharts-canvas {
      margin-top: -28px;
    }
    .profile-stats .apexcharts-toolbar {
      right: 16px;
    }
    @media (max-width: 600px) {
      .profile-stats {
        width: 100%;
      }
    }
    .additional-stats {
      text-align: center;
      font-size: 11px;
      margin-bottom: 20px;
    }
  `,
  initializer: ({ id }) => {
    drawChart(id, toChartOptions(stats.scores[type]))
  }
})

/**
 * When the numbers above were counted.
 *
 * They are a cache that stands for 48 hours — see api/controllers/stats.js —
 * so a profile can be a day and a half behind the entries it is drawn from,
 * and a reader comparing two of them is entitled to know which. The exact
 * moment goes in the `title`, as it does everywhere else `timeAgo` is used.
 *
 * `updatedDate` reaches this on both of the endpoint's paths as of #145; the
 * recomputing one used to leave it out. `timeAgo` answers "at an unknown
 * time" for a response that predates that, which is the honest thing to say
 * about it.
 */
const StatsFreshness = (updatedDate) => initComponent({
  content: () => html`
    <div class="stats-freshness" title="${dateTime(updatedDate)}">
      Counted ${timeAgo(updatedDate)}
    </div>
  `,
  style: () => css`
    .stats-freshness {
      text-align: right;
      font-size: 11px;
      color: #aaa;
    }
  `
})

const AdditionalStats = (relevantScores) => initComponent({
  content: () => html`
    <div class="additional-stats">
      Total rated: ${totalRated(relevantScores)} | Mean score: ${meanScore(relevantScores)} | Stdev: ${stdev(relevantScores)}
    </div>
  `
})

const GlobalStats = (stats) => initComponent({
  content: ({ id, include }) => html`
    <div class="profile-global-stats">
      <h3>Global stats</h3>
      <div id="profile-global-stats">
        <div id=${id}></div>
        ${include(AdditionalStats(aggregateStats(stats)))}
      </div>
    </div>
  `,
  initializer: ({ id }) => {
    drawChart(id, toChartOptions(aggregateStats(stats)))
  },
  style: () => css`
    #profile-global-stats {
      width: 48%;
    }

    @media (max-width: 768px) {
      #profile-global-stats {
        width: 100%;
      }
    }
  `
})

const { loadApexCharts } = LoadScript

/**
 * Draws one histogram into `#id`, once there is something to draw it with and
 * somewhere with a width to draw it in.
 *
 * ApexCharts is fetched on demand — see `utils/load_script.js` for why 862 KB
 * is no longer in `base.njk` — so this is asynchronous where it used to be a
 * constructor call. `loadApexCharts` hands every caller the same load, so the
 * five charts on this page are one request and one <script>.
 *
 * A failure leaves an empty container and nothing else: the tally under each
 * chart is markup rather than a chart, the lists above it are their own
 * requests, and the promise settles either way. A profile with no charts is a
 * worse page than one with them; a profile that hangs is a broken one.
 */
const drawChart = async (id, options) => {
  try {
    const ApexCharts = await loadApexCharts()
    const element = document.querySelector(`#${id}`)
    if (!element) return
    await whenLaidOut(element)
    // 862 KB is long enough to navigate away in, and this component is drawn
    // by `setContent`, which replaces what was there rather than emptying it.
    if (element.isConnected) new ApexCharts(element, options).render()
  } catch (error) {
    console.error(`a score histogram could not be drawn: ${error.message}`)
  }
}

/**
 * The element once the browser has given it a width — or after a couple of
 * frames, if it is never going to have one.
 *
 * `.render()` measures the container at the instant it is called and writes
 * that number into the SVG's `width`, where it stays. #268 caught all five
 * charts rendered at `width="0"` in containers that were 392px wide, and
 * awaiting the script is not on its own a fix for that: the await can resolve
 * in the same frame the container was inserted in, which is exactly the case
 * that used to fail. Reading `offsetWidth` forces the layout rather than
 * waiting for one, so the usual case costs nothing and the frames below are
 * only ever spent when the answer really is zero.
 *
 * An element that is not displayed at all is told apart from one that has
 * simply not been measured yet, and is not waited for: the Global stats tab is
 * `display: none` until it is clicked, so its container has no boxes and will
 * not get one until then. That chart is drawn zero-wide here exactly as it was
 * before — redrawing it when its tab is shown is a separate change — rather
 * than waiting on frames, which a document in a background tab does not hand
 * out at all. The frame bound is the backstop under that.
 */
const whenLaidOut = (element, frames = 2) =>
  new Promise((resolve) => {
    const attempt = (left) =>
      !element.isConnected ||
      element.offsetWidth > 0 ||
      element.getClientRects().length === 0 ||
      left === 0
        ? resolve(element)
        : requestAnimationFrame(() => attempt(left - 1))
    attempt(frames)
  })

// The buckets `getTallyOfScore` counts, in the order the chart draws them —
// top bar first. The bars and their labels are both derived from this one
// list, because a hand-written pair of arrays drifted apart once already:
// score 1 was missing from the data, so ApexCharts drew the unrated tally
// against the label `1`.
const BUCKETS = ['10', '9', '8', '7', '6', '5', '4', '3', '2', '1', 'unrated']

// A tally the user has none of can be a missing key rather than a zero, so
// every read of a bucket defaults.
const aggregateStats = (stats) =>
  Object.fromEntries(
    BUCKETS.map((bucket) => [
      bucket,
      Object.values(stats.scores)
        .reduce((tally, scoresOfType) => tally + (scoresOfType[bucket] ?? 0), 0)
    ])
  )


const toChartOptions = (relevantStats) => ({
  series: [{
    name: `Scores`,
    data: BUCKETS.map((bucket) => relevantStats[bucket] ?? 0)
  }],
  chart: {
    type: 'bar',
    height: 250,
  },
  plotOptions: {
    bar: {
      borderRadius: 4,
      horizontal: true,
    }
  },
  dataLabels: {
    enabled: false
  },
  xaxis: {
    categories: BUCKETS.map((bucket) => bucket === 'unrated' ? 'Unrated' : bucket),
  }
})

const totalRated = (relevantScores) =>
  Object.entries(relevantScores).reduce(
    (acc, [rating, tally]) => rating === 'unrated' ? acc : acc + tally,
    0
  )

const meanScore = (relevantScores) => {
  const scores = toArrayOfScores(relevantScores)
  return (scores.reduce((acc, cur) => acc + cur, 0) / scores.length).toFixed(2)
}

const stdev = (relevantScores) => {
  const scores = toArrayOfScores(relevantScores)
  const n = scores.length
  if (n === 0) return 0
  const mean = scores.reduce((a, b) => a + b) / n
  return (Math.sqrt(scores.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n))
    .toFixed(2)
}

const toArrayOfScores = (relevantScores) =>
  Object.entries(relevantScores)
    .filter(([rating, _]) => rating !== 'unrated')
    .flatMap(([rating, tally]) => [...Array(tally)].map(_ => parseInt(rating)))



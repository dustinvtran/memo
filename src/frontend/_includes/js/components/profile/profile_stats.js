const { entryTypes, getStats } = Netlify
const { col } = Tables
const { typeToTitle } = Conversions
const { html, css, timeAgo, dateTime } = Utils
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
  `
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
      <h3><a href="/${type}/${username}">${typeToTitle[type]}</a></h3>
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
    const relevantStats = stats.scores[type]
    new ApexCharts(
      document.querySelector(`#${id}`),
      toChartOptions(relevantStats)
    )
      .render()
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
    new ApexCharts(
      document.querySelector(`#${id}`),
      toChartOptions(aggregateStats(stats))
    )
      .render()
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



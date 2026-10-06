/**
 * Every user-facing string in the application. Components read from here and never write copy inline,
 * so wording can be reviewed in one place. Functions are used where a sentence carries a value.
 */
export const copy = {
  appName: "Delivery Metrics",
  skipToContent: "Skip to main content",

  common: {
    loading: "Loading",
    retry: "Try again",
    notAvailable: "No data",
    and: "and",
    cancel: "Cancel",
    save: "Save",
    saving: "Saving",
    close: "Close",
    viewAsTable: "View as table",
    backToRepos: "Back to repositories",
    backToSpaces: "Back to Jira spaces",
    requestFailed: (status: number) => `The request failed with status ${status}.`,
    networkFailed: "The dashboard could not reach its API. Check that the API is running and try again.",
    errorTitle: "Something went wrong",
    opensInNewTab: "(opens in a new tab)",
  },

  theme: {
    toLight: "Switch to light theme",
    toDark: "Switch to dark theme",
    light: "Light",
    dark: "Dark",
  },

  auth: {
    checking: "Checking your GitHub session",
    signInTitle: "Sign in to see your delivery metrics",
    signInBody: "The dashboard reads pull requests and deploy runs from GitHub using your own access.",
    signInButton: "Sign in with GitHub",
    ghCliTitle: "The GitHub CLI is not signed in",
    ghCliBody: "This dashboard uses the GitHub CLI session on the machine running the API.",
    ghCliInstruction: "Run the command below in a terminal, then reload this page.",
    ghCliCommand: "gh auth login",
    reload: "Reload",
    signOut: "Sign out",
    signedInAs: (login: string) => `Signed in as ${login}`,
    avatarAlt: (login: string) => `${login} avatar`,
    device: {
      or: "Or sign in with your GitHub account from this page.",
      starting: "Contacting GitHub",
      codeLabel: "Your one-time code",
      copy: "Copy code",
      copied: "Copied",
      stepsTitle: "To finish signing in",
      stepOpen: "Open the GitHub page using the link below.",
      stepEnter: "Enter the code shown above.",
      stepApprove: "Approve the request, then return to this page.",
      openLink: "Open GitHub to enter the code",
      newTab: "(opens in a new tab)",
      waiting: "Waiting for GitHub",
      expired: "The code has expired. Start again to get a new one.",
      denied: "The request was declined on GitHub. Start again if you would like to try once more.",
      incomplete:
        "GitHub approved the request, but the sign-in could not be completed here. Your browser may not be keeping the session cookie. Start again, and if it repeats, check that you are using a secure address.",
      tryAgain: "Try again",
    },
  },

  nav: {
    label: "Main",
    home: "Why it matters",
    repositories: "Repositories",
    reviewQueue: "Review queue",
    jira: "Jira",
  },

  repos: {
    title: "Repositories",
    lede: "Add the repositories you want to measure. Each one is crawled from GitHub in the background.",
    addTitle: "Add a repository",
    repoLabel: "Repository",
    repoHint: "Use owner/name, for example acme/widgets, or paste a github.com link.",
    repoPlaceholder: "acme/widgets",
    workflowLabel: "Deploy workflow (optional)",
    workflowHint: "Workflow file names whose successful runs count as deployments. Separate several with commas.",
    workflowPlaceholder: "deploy.yml",
    branchLabel: "Deploy branch (optional)",
    branchHint: "Only runs on this branch count as production deployments.",
    branchPlaceholder: "main",
    addButton: "Add repository",
    adding: "Adding",
    added: (name: string) => `${name} was added and its first crawl has started.`,
    listTitle: "Your repositories",
    emptyTitle: "No repositories yet",
    emptyBody: "Add a repository above to start collecting pull request and deployment history.",
    pullRequests: "Pull requests",
    deployRuns: "Deploy runs",
    lastCrawled: "Last crawled",
    neverCrawled: "Not yet crawled",
    deployConfig: "Deploys",
    noDeployWorkflow: "No deploy workflow configured",
    deployDescription: (workflows: string, branch: string) => `${workflows} on ${branch}`,
    status: {
      idle: "Up to date",
      crawling: "Crawling",
      failed: "Crawl failed",
    },
    crawlingFallback: "Starting crawl",
    recrawl: "Re-crawl",
    fullRecrawl: "Full re-crawl",
    configure: "Configure deploy",
    remove: "Remove",
    confirmRemove: (name: string) => `Remove ${name} and all of its collected history?`,
    selectForCompare: (name: string) => `Select ${name} for comparison`,
    compareButton: "Compare",
    compareHint: "Select two to four repositories to compare them side by side.",
    compareSelected: (count: number) => `${count} selected`,
    openDashboard: (name: string) => `Open the dashboard for ${name}`,
  },

  configure: {
    title: (name: string) => `Deploy settings for ${name}`,
    workflowsLegend: "Deploy workflows",
    workflowsHint: "Successful runs of the ticked workflows count as deployments.",
    loadingWorkflows: "Loading workflows",
    noWorkflows: "This repository has no GitHub Actions workflows.",
    branchLabel: "Deploy branch",
    saved: "Deploy settings saved. Re-crawl to pick up runs from newly ticked workflows.",
  },

  jira: {
    title: "Jira spaces",
    lede: "Jira issues are linked to this repository's pull requests by the issue key in the pull request title or branch name.",
    notConnectedTitle: "Jira is not connected",
    connect: "Connect Jira",
    connectAgain: "Connect Jira again",
    disconnect: "Disconnect Jira",
    disconnecting: "Disconnecting",
    unauthorisedTitle: "Your Jira connection has expired or is missing",
    unauthorisedBody: "Connect Jira again to carry on reading spaces. Links you have already saved are kept.",
    connectFailedTitle: "Jira could not be connected",
    connectFailedBody: "Atlassian did not complete the sign-in. Try connecting again.",
    dismiss: "Dismiss",
    loading: "Loading Jira",
    siteLabel: "Jira site",
    sitePlaceholder: "Choose a site",
    noSites: "Your Jira account has no sites the dashboard can read.",
    searchLabel: "Search spaces by name or key",
    spacesLegend: "Spaces to link",
    spacesHint: (max: number) => `Choose up to ${max} spaces. Saving replaces the spaces currently linked to this repository.`,
    loadingSpaces: "Loading spaces",
    noSpaces: "This site has no spaces you can read.",
    noMatches: "No spaces match your search.",
    showing: (shown: number, total: number) => `Showing ${shown} of ${total} spaces`,
    selectedCount: (count: number) => (count === 1 ? "1 space selected" : `${count} spaces selected`),
    limitReached: (max: number) => `You have reached the limit of ${max} spaces.`,
    saveLinks: "Save links",
    savingLinks: "Saving links",
    linksSaved: "Links saved. The spaces are being crawled now.",
    linkedTitle: "Linked spaces",
    noLinked: "No spaces are linked to this repository yet.",
    loadingLinked: "Loading linked spaces",
    siteHeading: "Site",
    workItems: "Work items",
    lastCrawled: "Last crawled",
    neverCrawled: "Not crawled yet",
    status: {
      idle: "Up to date",
      crawling: "Crawling",
      failed: "Crawl failed",
    },
    crawlingFallback: "Starting crawl",
    crawlAlreadyRunning: "This space is already being crawled. Its progress is shown above and will update on its own.",
    recrawl: "Re-crawl",
    fullRecrawl: "Full re-crawl",
    recrawlLabel: (name: string) => `Re-crawl ${name}`,
    fullRecrawlLabel: (name: string) => `Full re-crawl ${name}`,
    flowToggle: "How this space flows",
    flowToggleLabel: (name: string) => `How the ${name} space flows`,
    loadingFlow: "Loading statuses and columns",
    columnsTitle: "Board columns, left to right",
    noBoard: "This space has no board the dashboard can read, so only its statuses are shown.",
    noColumnStatuses: "No statuses",
    categoriesTitle: "Statuses by category",
    categories: {
      todo: "To do",
      in_progress: "In progress",
      done: "Done",
    },
    noStatuses: "This space has no statuses the dashboard can read.",
  },

  range: {
    legend: "Date range",
    from: "From",
    to: "To",
    presetsLabel: "Presets",
    allActive: "Period all were active",
    allTime: "All time",
    last90: "Last 90 days",
    last30: "Last 30 days",
    includeBots: "Include bots",
    includeBotsHint: "Count pull requests opened by automation accounts such as dependency updaters.",
  },

  dora: {
    title: "DORA measures",
    lede: "The four measures of software delivery performance, each placed in a performance band.",
    band: {
      elite: "Elite",
      high: "High",
      medium: "Medium",
      low: "Low",
    },
    bandLabel: (band: string) => `${band} performance band`,
    notMeasured: "Not measured",
    deploymentFrequency: "Deployment frequency",
    deploymentFrequencyDefinition: "How often a successful deploy reaches production.",
    perWeek: (value: string) => `${value} per week`,
    leadTime: "Lead time for changes",
    leadTimeDefinition: "Median time from a change's first commit to its successful deploy.",
    changeFailure: "Change failure rate",
    changeFailureDefinition: "Share of production deploys that failed.",
    timeToRestore: "Time to restore",
    timeToRestoreDefinition: "Median time from a failed deploy to the next successful one.",
    profileLead: "Graded against",
    profileMismatch: "These repositories were graded against different DORA profiles, so their bands are not comparable.",
    rework: "Rework rate",
    reworkDefinition: "Share of successful deploys that shipped at least one revert or hotfix pull request.",
    reworkNoBand: "DORA publishes no band for this measure, so none is shown.",
    reworkCount: (deploys: number, total: number) => `${deploys} of ${total} deploys shipped a revert or hotfix`,
    reasons: {
      noRework: "No successful deploys in this range, so there was nothing to check for reverts or hotfixes.",
      noWorkflow: "No deploy workflow is configured for this repository.",
      noRuns: (branch: string) => `No completed deploy runs on ${branch} in this range.`,
      noShipped: "No merged pull request was shipped by an observed deploy in this range.",
      noFailures: "No failed deploys in this range, so there was nothing to restore.",
      noRecovery: "No failed deploy has been followed by a successful one yet.",
      unrecovered: (since: string, runs: number) =>
        `Failures have not been put right since ${since}. ${runs} failed ${runs === 1 ? "run has" : "runs have"} had no successful deploy after ${runs === 1 ? "it" : "them"}.`,
    },
    deploysCount: (total: number, weeks: number) => `${total} successful deploys over ${weeks} weeks`,
    leadCount: (count: number) => `Across ${count} shipped pull requests`,
    failureCount: (failed: number, total: number) => `${failed} of ${total} deploys failed`,
    restoreCount: (count: number) => `Across ${count} recoveries`,
    explain: {
      summary: "Why this band, and how to move up",
      /** Read after the summary by assistive technology only, so each tile's disclosure names its measure. */
      summaryMeasure: (measure: string) => `, ${measure}`,
      meaningHeading: "What the band means",
      gapHeading: "How far to the next band",
      findingsHeading: "What drives this figure",
      practicesHeading: "Practices to try",
      systemNote: "These explanations describe stages, batches and workflows, never individual people.",
      source: {
        label: "2023 Accelerate State of DevOps Report, performance levels",
        href: "https://dora.dev/research/2023/dora-report/2023-dora-accelerate-state-of-devops-report.pdf#page=12",
      },
      meaning: {
        deploymentFrequency: {
          elite:
            "Changes reach production on demand, whenever one is ready, which is the pace DORA's 2023 report gives for its elite cluster.",
          high: "The team deploys between once a day and once a week, the pace of DORA's high cluster.",
          medium: "The team deploys between once a week and once a month, the pace of DORA's medium cluster.",
          low: "The team deploys less often than once every four weeks, which is slower than any range DORA's 2023 report gives for its medium cluster.",
        },
        leadTime: {
          elite: "A typical change reaches production less than a day after it is committed, as in DORA's elite cluster.",
          high: "A typical change takes between one day and one week to reach production, as in DORA's high cluster.",
          medium: "A typical change takes between one week and one month to reach production, as in DORA's medium cluster.",
          low: "A typical change takes longer than a month to reach production, which is slower than any range DORA's 2023 report gives for its medium cluster.",
        },
        changeFailure: {
          elite:
            "About one deployment in twenty or fewer needs immediate intervention, matching the 5% DORA reports for its elite cluster.",
          high: "About one deployment in ten or fewer needs immediate intervention, matching the 10% DORA reports for its high cluster.",
          medium:
            "Up to about one deployment in seven needs immediate intervention, matching the 15% DORA reports for its medium cluster.",
          low: "More than 15% of deployments need immediate intervention; DORA's 2023 low cluster reported 64%.",
        },
        timeToRestore: {
          elite: "A failed deployment is typically put right in less than an hour, as in DORA's elite cluster.",
          high: "A failed deployment is typically put right in less than a day, as in DORA's high cluster.",
          medium: "A failed deployment typically takes between one day and one week to put right, as in DORA's medium cluster.",
          low: "A failed deployment typically takes longer than a week to put right; DORA's 2023 low cluster reported between one month and six months.",
        },
      },
      restoreRename:
        "DORA's 2023 report calls this measure failed deployment recovery time. This dashboard keeps the label time to restore.",
      reviewQuote: {
        text: "Speeding up code reviews is one of the most effective paths to improving software delivery performance. Teams with faster code reviews have 50% higher software delivery performance.",
        label: "2023 report, executive summary",
        href: "https://dora.dev/research/2023/dora-report/2023-dora-accelerate-state-of-devops-report.pdf#page=5",
      },
      gap: {
        raise: (value: string, band: string, requirement: string, by: string) =>
          `Deployments run at ${value}. The ${band} band needs ${requirement}, which is ${by} more than now.`,
        lowerRate: (value: string, band: string, requirement: string, by: string) =>
          `${value} of deploys failed. The ${band} band needs ${requirement}, which is ${by} lower than now.`,
        lowerDuration: (value: string, band: string, requirement: string, by: string) =>
          `The median is ${value}. The ${band} band needs ${requirement}, which is ${by} shorter than now.`,
        onLimit: (value: string, band: string, requirement: string) =>
          `The median is ${value}, which sits exactly on the limit for the ${band} band. That band needs ${requirement}, so the figure must fall below the limit to qualify.`,
        holds: (value: string, requirement: string, margin: string) =>
          `At ${value} the figure is ${margin} inside the elite requirement of ${requirement}, which keeps it in the elite band.`,
        holdsOnLimit: (value: string, requirement: string) =>
          `At ${value} the figure sits exactly on the elite requirement of ${requirement}, and that limit itself counts, so it stays in the elite band.`,
        atLeast: (value: string) => `at least ${value}`,
        atMost: (value: string) => `${value} or less`,
        under: (value: string) => `under ${value}`,
        points: (value: string) => `${value} ${value === "1" ? "percentage point" : "percentage points"}`,
      },
      parts: {
        coding: "Coding",
        waitingForReview: "Waiting for review",
        inReview: "In review",
        toMerge: "Approval to merge",
        toDeploy: "Merge to deploy",
      },
      findings: {
        largestPart: (part: string, hours: string, share: string, mean: string) =>
          `${part} is the largest part of lead time, averaging ${hours}, or ${share} of the ${mean} mean. The tile shows the median, so the parts add up to the mean rather than to the tile.`,
        nextPart: (part: string, hours: string, share: string) =>
          `${part} comes next, averaging ${hours}, or ${share} of the mean.`,
        spread: (p75: string, size: string | null) =>
          size === null
            ? `One in four changes took ${p75} or longer from first commit to deploy.`
            : `One in four changes took ${p75} or longer from first commit to deploy, and the median change was ${size} lines.`,
        fewDeploys: (deploys: number, tileWeeks: number, complete: number, without: number) =>
          `The tile divides ${deploys} successful ${deploys === 1 ? "deploy" : "deploys"} by ${tileWeeks} ${tileWeeks === 1 ? "week" : "weeks"}, counting every week the range touches, partial ones included. ` +
          (complete === 0
            ? "None of those weeks was complete, so none is counted as a week without a deploy."
            : `Of the ${complete} complete ${complete === 1 ? "week" : "weeks"}, ${without} had no deploy.`),
        largeBatches: (median: string) =>
          `The median deploy shipped ${median} pull requests, so changes are released in batches.`,
        failures: (failed: number, total: number, rate: string) =>
          `${failed} of ${total} production deploys failed, which is ${rate}.`,
        worstWorkflow: (workflow: string, failed: number, total: number) =>
          `Most failures came from the ${workflow} workflow, ${failed} of its ${total} runs.`,
        rework: (deploys: number, total: number) =>
          `${deploys} of ${total} successful deploys shipped a revert or hotfix pull request.`,
        streaks: (streaks: number, median: string | null, longest: string | null) =>
          `${streaks} failure ${streaks === 1 ? "streak was" : "streaks were"} put right` +
          (median === null ? "" : `, with a median of ${median} failed ${median === "1" ? "run" : "runs"} per streak`) +
          (longest === null ? "" : `, and the longest took ${longest}`) +
          ".",
        unrecovered: (since: string, runs: number) =>
          `${runs} failed ${runs === 1 ? "run has" : "runs have"} had no successful deploy after ${runs === 1 ? "it" : "them"} since ${since}.`,
      },
      practices: {
        workingInSmallBatches: {
          name: "Working in small batches",
          href: "https://dora.dev/capabilities/working-in-small-batches/",
          why: "Smaller pieces of work get feedback sooner and are easier to triage and fix, and the 2023 report names reducing batch size as a common way to improve all four measures.",
        },
        trunkBasedDevelopment: {
          name: "Trunk-based development",
          href: "https://dora.dev/capabilities/trunk-based-development/",
          why: "Merging small changes into trunk at least daily, on branches that last hours rather than days, keeps merges simple, and the page advises making review synchronous or a priority.",
        },
        streamliningChangeApproval: {
          name: "Streamlining change approval",
          href: "https://dora.dev/capabilities/streamlining-change-approval/",
          why: "DORA found that peer review inside the development process, backed by automated checks, works better than approval from outside the team, which slows delivery and enlarges batches.",
        },
        deploymentAutomation: {
          name: "Deployment automation",
          href: "https://dora.dev/capabilities/deployment-automation/",
          why: "A push-button deploy that works the same way in every environment lowers the risk of each deployment and lets anyone with the right access deploy any version on demand, including a known good one.",
        },
        continuousDelivery: {
          name: "Continuous delivery",
          href: "https://dora.dev/capabilities/continuous-delivery/",
          why: "Keeping the software deployable at all times means a change can be released on demand, and DORA reports that doing this well improves all four key metrics.",
        },
        continuousIntegration: {
          name: "Continuous integration",
          href: "https://dora.dev/capabilities/continuous-integration/",
          why: "Integrating into trunk at least daily, with automated tests on every commit, keeps the software working and branches close to trunk.",
        },
        testAutomation: {
          name: "Test automation",
          href: "https://dora.dev/capabilities/test-automation/",
          why: "Tests that run on every change give fast feedback, and DORA's research links this to better software stability and a short lead time from check-in to release.",
        },
        codeMaintainability: {
          name: "Code maintainability",
          href: "https://dora.dev/capabilities/code-maintainability/",
          why: "Code that is easy to find, reuse and change, with stable dependencies, lets a team change any part of the codebase quickly when an incident needs it.",
        },
        monitoringAndObservability: {
          name: "Monitoring and observability",
          href: "https://dora.dev/capabilities/monitoring-and-observability/",
          why: 'Tooling that shows the health of the system and lets the team debug production contributes to continuous delivery, and the page calls time to restore "the key metric in the event of an outage or service degradation".',
        },
        proactiveFailureNotification: {
          name: "Proactive failure notification",
          href: "https://dora.dev/capabilities/proactive-failure-notification/",
          why: "Alerting when monitored values approach a known failure threshold, rather than hearing about a failure from users, lets a team diagnose and solve problems quickly.",
        },
      },
      moveUp: {
        title: "How teams move up",
        body: 'DORA\'s research treats these measures as a baseline rather than a target. Its 2023 report says they "are not the means by which a team will improve"; a team improves by finding the capability that is holding it back, giving itself time to experiment, and checking again. The change DORA most often recommends is to make each change smaller, because "smaller changes are easier to reason about and to move through the delivery process" and are "easy to recover from if there\'s a failure". Each explanation on a repository\'s page names the largest driver in the team\'s own data and links to the DORA capabilities that address it. The fairest comparison is the same repository over time, since DORA warns that comparing different applications "discards the context of each application".',
        linksLead: "Good places to start are",
        links: ["workingInSmallBatches", "continuousDelivery", "testAutomation"] as const,
      },
      system: {
        quote:
          "Software delivery performance is not an individual measure; it measures your ability to change and update an application, and this can only be done by teams.",
        label: "DORA, how to empower software delivery teams",
        href: "https://dora.dev/guides/how-to-empower-software-delivery-teams/",
      },
      meaningTitle: "What each band means",
      meaningLede: "One line for each band, following the performance levels in DORA's 2023 report.",
      whyBand: "Why this band",
      whyBandRow: "Why each band",
      whyBandLabel: (repo: string) => `Why this band, ${repo}`,
    },
  },

  aiCohorts: {
    title: "AI-assisted work",
    lede: "Merged pull requests marked as AI-assisted set beside those that are not, so the two can be compared rather than guessed at.",
    caption: "Merged pull requests, AI-assisted against unassisted",
    measure: "Measure",
    assisted: "AI-assisted",
    unassisted: "Unassisted",
    prs: "Pull requests",
    medianCycle: "Median cycle time",
    p75Cycle: "75th percentile cycle time",
    medianSize: "Median size (lines)",
    reviewed: "Reviewed by someone else",
    reverts: "Revert or hotfix share",
    cycleNote: "Cycle time runs from the first commit to the merge, not to the deploy.",
    rule: "A pull request counts as AI-assisted when it carries the label ai-assisted, or when one of its commits has a Co-Authored-By trailer naming an assistant such as Claude or Copilot. Use of an assistant that leaves no label or trailer counts as unassisted, so the AI-assisted figures are a floor rather than a total.",
    unknown: (count: number) =>
      `${count} merged ${count === 1 ? "pull request" : "pull requests"} could not be classified because labels and trailers were not recorded when they were crawled.`,
    unknownHint: "Run a full crawl of this repository to record them.",
  },

  flow: {
    title: "Pull request flow",
    lede: "How work moves from first commit to merge. Medians are used so a few outliers do not dominate.",
    merged: "PRs merged",
    mergedHint: (opened: number) => `${opened} opened in this range`,
    coding: "Coding time",
    codingHint: "Median first commit to PR opened",
    firstReview: "Time to first review",
    firstReviewHint: "Median ready for review to first review",
    openToMerge: "Open to merge",
    openToMergeHint: (p75: string) => `Median, 75th percentile ${p75}`,
    reviewed: "Reviewed",
    reviewedHint: "Share of merged PRs reviewed by someone else",
    selfMerged: "Self-merged",
    selfMergedHint: "Share of merged PRs merged by their author",
    perAuthorWeek: "Merged per author-week",
    perAuthorWeekHint: "Merged PRs divided by weekly active authors",
  },

  charts: {
    weekStarting: "Week starting",
    zoomLabel: "Weeks shown. Drag either handle to widen or narrow the range, or drag the band to move along it.",
    hours: "Hours",
    share: "Share of merged PRs",
    count: "Count",
    openedVsMerged: {
      title: "Pull requests opened and merged",
      subtitle: "Weekly count of pull requests opened against those merged.",
      opened: "Opened",
      merged: "Merged",
    },
    weeklyOpenToMerge: {
      title: "Median open to merge",
      subtitle: "The median time a pull request merged that week spent open, in hours.",
      series: "Median open to merge",
    },
    deploys: {
      title: "Deploys and failures",
      subtitle: "Weekly count of successful and failed production deploys.",
      deploys: "Successful deploys",
      failures: "Failed deploys",
    },
    stages: {
      title: "Cycle time by stage",
      subtitle: "Mean hours per stage for pull requests merged each week. Means are shown because they add up to the whole bar.",
      coding: "Coding",
      waitingForReview: "Waiting for review",
      inReview: "In review",
      toMerge: "To merge",
      stage: "Stage",
      meanHours: "Mean hours",
    },
    distribution: {
      title: "Time to merge",
      subtitle: "How long merged pull requests stayed open, as a share of all merged pull requests.",
      bucket: "Time open",
    },
    scatter: {
      title: "Pull request size and time to merge",
      subtitle: "Each dot is a merged pull request. Both axes use a log scale so small and large changes are visible together.",
      size: "Lines changed",
      openToMerge: "Hours open",
      pr: "Pull request",
    },
    noData: "No data in this range.",
  },

  authors: {
    title: "Authors",
    subtitle: "Pull request activity by author in this range.",
    login: "Author",
    opened: "Opened",
    merged: "Merged",
    medianOpenToMerge: "Median open to merge",
    reviewsGiven: "Reviews given",
    empty: "No authors in this range.",
  },

  prTable: {
    title: "Pull requests",
    subtitle: "Pull requests opened in this range. Select a column heading to sort.",
    number: "Number",
    titleColumn: "Title",
    author: "Author",
    opened: "Opened",
    merged: "Merged",
    openToMerge: "Open to merge",
    firstReview: "First review",
    size: "Lines",
    reviewed: "Reviewed",
    yes: "Yes",
    no: "No",
    notMerged: "Open or closed",
    previous: "Previous page",
    next: "Next page",
    pageOf: (page: number, pages: number) => `Page ${page} of ${pages}`,
    empty: "No pull requests were opened in this range.",
    sortBy: (column: string) => `Sort by ${column}`,
  },

  authorFilter: {
    summary: (included: number, total: number) =>
      included === total ? `All authors (${total})` : included === 0 ? "No authors" : `${included} of ${total} authors`,
    hint: "Untick an author to leave their pull requests out of every figure on this page. Deploys, failure rate and restore time come from workflow runs, so of the DORA measures only lead time changes.",
    all: "All authors",
    none: "No authors",
    legend: "Authors to include",
    opened: (count: number) => (count === 1 ? "1 PR" : `${count} PRs`),
    noneChosen: "Every author is left out, so there is nothing to measure. Choose at least one author from the authors menu.",
  },

  report: {
    download: "Download PDF report",
    hint: "Opens your browser's print dialog. Choose Save as PDF as the destination.",
    prepared: (day: string) => `Report prepared on ${day}`,
    compareSubject: (names: readonly string[]) => names.join(" vs "),
  },

  codeHealth: {
    title: "Code health",
    lede: "A verdict on the default branch as it stands after the most recent crawl, with what is good, what to improve and the figures behind it. The grade does not follow the date range, which only decides which merged pull requests count towards the testing figure.",
    analysedAt: (sha: string, when: string) => `Analysed commit ${sha} on ${when}`,
    loading: "Loading code health",
    staleTitle: "The latest analysis failed",
    stale: (commitDate: string, attemptDate: string, message: string) =>
      `These figures are from the commit dated ${commitDate}. The latest attempt on ${attemptDate} failed with the message "${message}".`,
    yes: "Yes",
    no: "No",
    unknown: "Not known",

    verdict: {
      title: "Overall grade",
      definition: "The lowest of the three parts below, because code is only as healthy as its weakest area.",
      lowestPart: (part: string, sentence: string) => `${part} is the lowest part. ${sentence}.`,
      allPass: "All checks pass in every part.",
      bandName: (band: string) => `${band} code health`,
      missingTitle: "No grade yet",
      missing:
        "The grade needs the repository's tooling files as well as its functions, so it has not been produced for this analysis. The next crawl will produce it.",
    },

    parts: {
      title: "Grade by part",
      maintainability: "Maintainability",
      testing: "Testing",
      hygiene: "Hygiene",
      maintainabilityDefinition: "How much of the code sits in complex, long or wide functions.",
      testingDefinition: "How much test code there is, and whether pull requests and CI keep it up.",
      hygieneDefinition: "Whether a linter and a formatter are set up and run in CI.",
      limitedBy: (sentence: string) => `${sentence}.`,
      nothingLimits: "All checks in this part pass.",
    },

    lists: {
      goodTitle: "Good",
      goodEmpty: "Nothing stands out as a strength yet.",
      improveTitle: "To improve",
      improveEmpty: "Nothing needs improving.",
      improveHint: "Listed with the most serious first.",
    },

    findings: {
      linesAboveWarn: (good: boolean, share: string) =>
        `${good ? "Only " : ""}${share} of source lines are in functions above complexity 10`,
      linesAboveHigh: (good: boolean, share: string) =>
        `${good ? "Only " : ""}${share} of source lines are in functions above complexity 20`,
      longFunctions: (
        good: boolean,
        share: string,
        count: number | undefined,
        longest: { name: string; nloc: number } | null,
      ) => {
        if (good) return `Only ${share} of functions are longer than 60 lines`;
        if (count === undefined) return `${share} of functions are longer than 60 lines`;
        const lead = `${count} ${count === 1 ? "function is" : "functions are"} longer than 60 lines`;
        return longest ? `${lead}, the longest being ${longest.name} at ${longest.nloc} lines` : lead;
      },
      manyParams: (good: boolean, share: string, count: number | undefined) => {
        if (good) return `Only ${share} of functions take more than 5 parameters`;
        if (count === undefined) return `${share} of functions take more than 5 parameters`;
        return `${count} ${count === 1 ? "function takes" : "functions take"} more than 5 parameters`;
      },
      testRatio: (good: boolean, poor: boolean, ratio: string) =>
        ratio === "0.00"
          ? "No test code was found"
          : `Test code is ${good || !poor ? "" : "only "}${ratio} of the size of source code`,
      prsWithTests: (good: boolean, poor: boolean, share: string, withTests: number, total: number) =>
        good || !poor
          ? `${share} of merged pull requests that changed source also changed tests (${withTests} of ${total})`
          : `Only ${share} of merged pull requests changed tests alongside code (${withTests} of ${total})`,
      ciRunsTests: (good: boolean) => (good ? "CI runs the tests" : "CI does not run the tests"),
      coverageFloor: (floor: number | null, good: boolean) =>
        floor === null
          ? "No coverage floor is set"
          : good
            ? `A coverage floor of ${floor}% is configured`
            : `A coverage floor of ${floor}% is configured but below the 60% needed for elite`,
      linter: (tools: readonly string[]) =>
        tools.length > 0 ? `A linter is configured (${tools.join(", ")})` : "No linter is configured",
      formatter: (tools: readonly string[], onlyEditorconfig: boolean) =>
        tools.length > 0
          ? `A formatter is configured (${tools.join(", ")})`
          : onlyEditorconfig
            ? "No formatter is configured, because an editorconfig file only guides editors"
            : "No formatter is configured",
      ciLinter: (tools: readonly string[]) =>
        tools.length > 0 ? `The linter runs in CI (${tools.join(", ")})` : "CI does not run a linter",
      ciFormat: (tools: readonly string[]) =>
        tools.length > 0 ? `Formatting is checked in CI with ${tools.join(", ")}` : "CI does not check formatting",
    },

    detail: {
      title: "Detail",
      above: (limit: number) => `Functions above ${limit}`,
      aboveValue: (count: string, share: string) => `${count} (${share})`,
      aboveHint: (limit: number) => `Source functions with a complexity above ${limit}, and their share of all source functions.`,
      mostComplex: "Most complex function",
      mostComplexValue: (ccn: string) => `Complexity ${ccn}`,
      mostComplexNone: "No functions",
      mostComplexHint: (name: string, location: string) => `${name} at ${location}`,
      nloc: "Source lines",
      nlocHint: "Lines of code inside source functions, leaving out blank lines and comments.",
      functions: "Source functions",
      functionsHint: (tests: string) => `${tests} test functions are counted separately, and only feed the test ratio.`,
    },

    explainerTitle: "What cyclomatic complexity means",
    explainer:
      "Cyclomatic complexity counts the independent paths through a function, so each branch, loop or condition adds one. A low score is easy to read and to test. Scores above 10 are worth reviewing and scores above 20 are hard to change safely.",

    chart: {
      title: "Complexity distribution",
      subtitle: "How many source functions fall into each complexity range, where a higher score means more paths to test.",
      x: "Cyclomatic complexity",
      series: "Functions",
      keyTitle: "What the ranges mean",
      key: [
        { range: "1 to 10", meaning: "Simple" },
        { range: "11 to 20", meaning: "Moderate" },
        { range: "21 to 50", meaning: "Complex" },
        { range: "Over 50", meaning: "Very hard to test" },
      ],
    },

    testing: {
      title: "Testing checks",
      subtitle: "Signals read from the repository's files and its merged pull requests.",
      ratio: "Test ratio",
      ratioValue: (ratio: string) => `${ratio} lines inside test functions per line inside source functions`,
      prs: "Pull requests that changed tests",
      prsValue: (share: string, withTests: number, total: number) => `${share} (${withTests} of ${total} that changed source)`,
      prsNeedsCrawl: "Needs a full crawl, because file names have not been collected for these pull requests",
      prsNone: "No merged pull requests in this range changed source code",
      floor: "Coverage floor",
      floorNone: "None set",
      floorValue: (floor: number) => `${floor}% of lines, configured`,
      floorBelow: (floor: number) => `${floor}% of lines, configured but below the 60% needed for elite`,
      ci: "CI runs tests",
      unavailable: "The repository's files were not read for this analysis, so the tooling checks are not known yet.",
    },

    hygiene: {
      title: "Hygiene checks",
      subtitle: "Each tool found in the repository, and whether CI runs it.",
      tool: "Tool",
      kind: "Kind",
      configured: "Configured",
      enforced: "Runs in CI",
      linter: "Linter",
      formatter: "Formatter",
      weak: "Editor settings only",
      weakNote: "Weak, because it guides editors but does not check or change code.",
      notApplicable: "Not applicable",
      none: "No linter or formatter was found.",
    },

    hotspots: {
      title: "Most complex functions",
      subtitle:
        "The functions with the highest complexity. Complexity is weighed with length, because the grade counts the lines inside complex functions, so a long complex function costs more than a short one.",
      function: "Function",
      location: "File and line",
      ccn: "Complexity",
      nloc: "Lines",
      advice: "What would help",
      startHere: "Start here",
      adviceFor: {
        component: "Extracting a subcomponent for each state or section usually makes this component easier to follow.",
        dense:
          "This function has many small branches, often defaults or a case per value, so a lookup table or small helpers usually reads better, and part of the score comes from how the analyser counts.",
        long: "This function is long as well as branching, so splitting it into named steps usually helps most.",
        branching: "Naming the conditions as small helper functions usually makes this function easier to follow.",
        within: "This function is within every complexity and length limit, so it needs no change.",
      },
      empty: "No functions were found.",
    },

    start: {
      title: "Where to start",
      lift: (count: number, lines: number, from: string, to: string) =>
        `Simplifying ${count === 1 ? "this function" : `these ${count} functions`} (${lines} lines) would lift maintainability from ${from} to ${to}.`,
      functionItem: (name: string, location: string, lines: number) => `${name} at ${location} (${lines} lines)`,
      floor:
        "This is the least that would be needed, because changes that add lines elsewhere, or a function that stays above a limit after simplifying, can call for more. A function listed here may not appear in the table below, which shows only the ten most complex.",
      elite: "Maintainability is already in the elite band, so no function needs simplifying to lift it.",
    },

    partly: {
      title: "Some functions may not have been measured",
      body: (count: number) =>
        `The analyser, lizard, may have skipped some functions in ${count === 1 ? "this file" : `these ${count} files`} because of JSX spread attributes such as {...props}, so the figures can read better than the code is.`,
      more: (count: number) => `and ${count} more`,
    },

    none: {
      title: "Code health has not been measured yet",
      body: "Crawl this repository to clone the default branch and analyse its functions.",
    },
    error: {
      title: "Code health could not be measured",
      when: (when: string) => `The last attempt was on ${when}.`,
    },

    install: {
      title: "Install lizard on the machine that runs the API",
      intro: "Choose whichever of these suits the machine. Each installs the same tool.",
      options: [
        { label: "Any platform, if you already use uv", commands: ["uv tool install lizard"] },
        { label: "Any platform, if you already use pipx", commands: ["pipx install lizard"] },
        { label: "macOS, with Homebrew", commands: ["brew install pipx", "pipx ensurepath", "pipx install lizard"] },
        { label: "Windows, with winget", commands: ["winget install --id astral-sh.uv -e", "uv tool install lizard"] },
        {
          label: "Windows, with Python already installed",
          commands: ["py -m pip install --user pipx", "py -m pipx ensurepath", "py -m pipx install lizard"],
        },
      ],
      after:
        "Open a new terminal and run lizard --version to check it is on the PATH. If the API was already running, restart it so it can find lizard, then crawl the repository again.",
    },
  },

  repo: {
    loadingTitle: "Loading repository",
    lastCrawled: (when: string) => `Last crawled ${when}`,
    rangeSummary: (from: string, to: string) => `Showing ${from} to ${to}`,
    excludingAuthors: (logins: readonly string[]) =>
      `Leaving out pull requests by ${new Intl.ListFormat("en-GB", { type: "conjunction" }).format(logins)}.`,
    crawlInProgress: "A crawl is in progress, so these figures may still change.",
    notFound: "This repository could not be found.",
  },

  spaces: {
    title: "Jira spaces",
    lede: "The spaces the dashboard has crawled from Jira. Open one to see how its work flows from idea to production.",
    loading: "Loading Jira spaces",
    emptyTitle: "No Jira spaces are tracked yet",
    emptyBody:
      "Open Configure deploy on a repository and link a space under Jira spaces. The space is crawled once it is linked, and it then appears here.",
    toRepos: "Go to repositories",
    offTitle: "Jira is not switched on",
    offBody: "Add the Atlassian settings to the API's .env file and restart it, then connect Jira from a repository.",
    site: "Site",
    issues: "Issues",
    lastCrawled: "Last crawled",
    neverCrawled: "Not crawled yet",
    linkedRepos: "Linked repositories",
    noLinkedRepos: "None linked",
  },

  space: {
    loadingTitle: "Loading space",
    notFoundTitle: "This space could not be found",
    notFoundBody: "It may have been unlinked, or Jira may not be switched on for this dashboard.",
    toSpaces: "Go to Jira spaces",
    rangeSummary: (from: string, to: string) => `Showing ${from} to ${to}`,
    lastCrawled: (when: string) => `Last crawled ${when}`,
    showPeople: "Show people",
    showPeopleHint: "Group the hygiene lists by assignee name. Names never appear in charts or tiles.",
    showAll: (count: number) => `Show all ${count}`,
    showFewer: "Show fewer",
    openInJira: "(opens in Jira)",

    headline: {
      title: "Delivery from Jira",
      lede: "Stories, bugs, tasks and features are counted. Sub-tasks roll up into their parent, and epics are shown apart rather than counted.",
      done: "Done",
      doneHint: (created: number) => `Items finished in this range, with ${created} created`,
      inProgress: "In progress",
      inProgressHint: (epics: number) =>
        `At the end of the range, with ${epics} ${epics === 1 ? "epic" : "epics"} open and not counted`,
      cycle: "Issue cycle time",
      cycleHint: (p75: string) => `Median started to done, 75th percentile ${p75}`,
      lead: "Issue lead time",
      leadHint: (p75: string) => `Median created to done, 75th percentile ${p75}`,
      flowEfficiency: "Flow efficiency",
      flowEfficiencyHint: "Time spent actively worked as a share of started to done",
      linked: "Linked to a pull request",
      linkedHint: (linked: number, of: number) => `${linked} of ${of} done items have at least one pull request`,
    },

    flow: {
      title: "Flow",
      lede: "How much work finishes each week, how much is under way at once, and what has been waiting longest.",
      throughput: {
        title: "Items done each week",
        subtitle: "Delivery items finished each week, stacked by issue type. Weeks still running are left out.",
        total: "Total",
        /** The one series every issue type beyond story, bug, task and feature is folded into. */
        otherType: "Other",
      },
      wip: {
        title: "Work in progress",
        subtitle: "Delivery items in an in-progress status at the end of each week. Weeks still running are left out.",
        series: "In progress",
      },
      ageing: {
        title: "Ageing work",
        subtitle: "Items in progress now, oldest first, with the time since they started.",
        key: "Issue",
        summary: "Summary",
        type: "Type",
        status: "Status",
        age: "Age",
        empty: "Nothing is in progress at the end of this range.",
      },
    },

    columns: {
      title: "Time per column",
      lede: "Where finished work spent its time on the board.",
      chartTitle: "Mean time in each board column",
      subtitle:
        "Mean hours per done item in each column, from started to done, so the columns add up to the mean issue cycle time.",
      column: "Column",
      mean: "Mean",
      median: "Median",
      items: "Items",
      barLabel: "Mean time",
      /** Time in statuses that no board column holds. */
      notOnBoard: "Not on the board",
    },

    idea: {
      title: "Idea to production",
      lede: (linked: number, of: number, share: string) =>
        `Only done items with a linked pull request can be measured, so these figures cover ${linked} of ${of} done items (${share}). Work with no linked pull request is left out, which makes the times look better than the whole picture.`,
      toFirstPr: "Issue to first pull request",
      toFirstPrHint: (p75: string, count: number) =>
        `Median created to first pull request opened, 75th percentile ${p75}, across ${count} items`,
      toProduction: "Issue to production",
      toProductionHint: (p75: string, count: number) =>
        `Median created to the deploy that shipped the last pull request, 75th percentile ${p75}, across ${count} items`,
    },

    hygiene: {
      title: "Jira hygiene",
      lede: "Prompts to tidy the board so the figures above can be trusted. They are not a score, and some work genuinely needs no code.",
      checkThese: "Check these",
      none: "Nothing to check here.",
      found: (count: number) => `${count} to check`,
      foundOf: (count: number, of: number, share: string) => `${count} of ${of} to check (${share})`,
      unassigned: "Unassigned",
      movedTogether: (count: number, at: string) => `${count} moved to done at ${at}`,
      checks: {
        pr_without_key: {
          title: "Pull requests with no issue key",
          explanation:
            "Merged pull requests whose title or branch names no Jira issue, so their work cannot be traced back to the board.",
        },
        done_without_pr: {
          title: "Done items with no pull request",
          explanation:
            "Items marked done that no pull request mentions. Some work needs no code, so check whether a key is missing.",
        },
        skipped_in_progress: {
          title: "Done items that skipped in progress",
          explanation: "Items that went straight to done without being started, which hides how long the work really took.",
        },
        bulk_move: {
          title: "Items closed together",
          explanation:
            "Five or more items moved to done within ten minutes, which usually means the board was tidied rather than updated as work finished.",
        },
        reopened: {
          title: "Reopened items",
          explanation: "Items moved from done back into work, which is worth a look at what was missed the first time.",
        },
        stale_in_progress: {
          title: "Stale work in progress",
          explanation: "Items in progress with no update in the seven days before the end of the range.",
        },
        in_progress_unassigned: {
          title: "In progress with no assignee",
          explanation: "Items being worked on that nobody is shown as owning.",
        },
      },
    },
  },

  compare: {
    title: "Compare repositories",
    lede: "The same measures for each repository on shared axes. Each repository keeps one colour throughout.",
    needTwo: "Pick at least two repositories to compare.",
    tooMany: "Only the first four repositories are compared.",
    controls: "Comparison options",
    align: "Align to project start",
    alignHint: "Count weeks from each project's first pull request instead of by calendar date.",
    perContributor: "Per contributor",
    perContributorHint: "Divide weekly throughput by the number of people active that week.",
    showPeople: "Show people",
    showPeopleHint: "Off by default so the comparison stays about process rather than individuals.",
    logScale: "Log scale",
    alignedAxis: "Week N since first PR",
    weekN: (n: number) => `Week ${n}`,
    clippedNote: (weeks: number) =>
      `Aligned view is clipped to ${weeks} weeks, the length of the shortest history, so every repository covers the same span.`,
    missing: (count: number) =>
      count === 1 ? "One requested repository could not be found." : `${count} requested repositories could not be found.`,
    headline: {
      title: "Headline figures",
      subtitle: "One column per repository for the selected range.",
      metric: "Measure",
      merged: "PRs merged",
      authors: "Authors",
      authorWeeks: "Author-weeks",
      perAuthorWeek: "Merged per author-week",
      medianSize: "Median PR size (lines)",
      coding: "Median coding time",
      firstReview: "Median time to first review",
      openToMerge: "Median open to merge",
      openToMergeReviewed: "Median open to merge, reviewed",
      openToMergeUnreviewed: "Median open to merge, unreviewed",
      reviewed: "Share reviewed",
      selfMerged: "Share self-merged",
      deploysPerWeek: "Deploys per week",
      leadTime: "Lead time for changes",
      changeFailure: "Change failure rate",
      timeToRestore: "Time to restore",
    },
    cumulative: {
      title: "Cumulative pull requests merged",
      subtitle: "Running total of merged pull requests for each repository.",
      yLabel: "PRs merged to date",
    },
    throughput: {
      title: "Pull requests merged per week",
      titlePerContributor: "Pull requests merged per active author per week",
      subtitle: "Weekly merged pull requests for each repository.",
      subtitlePerContributor: "Weekly merged pull requests divided by the number of people active that week.",
      yLabel: "PRs merged",
      yLabelPerContributor: "PRs merged per author",
    },
    openToMerge: {
      title: "Median open to merge per week",
      subtitle: "The median hours a pull request merged that week spent open.",
      logNote: "Weeks with a zero median are left out on a log scale.",
      yLabel: "Time open",
    },
    distribution: {
      title: "Time to merge distribution",
      subtitle:
        "Share of each repository's merged pull requests in each time bucket, so repositories of different sizes compare fairly.",
    },
    composition: {
      title: "Cycle time composition",
      subtitle: "Mean of the weekly stage means over the range, shown as a share of the whole cycle.",
      noStages: "No merged pull requests with stage data in this range.",
    },
    deploys: {
      title: "Deploys per week",
      subtitle: "Weekly successful production deploys for each repository.",
      yLabel: "Deploys",
    },
    batch: {
      title: "Batch size",
      subtitle: "Lines merged per author-week and median pull request size for each repository.",
      caveat:
        "Lines changed include generated files, lockfiles and vendored code, so treat them as an indication of batch size rather than output.",
      linesPerAuthorWeek: "Lines merged per author-week",
      medianSize: "Median PR size (lines)",
    },
    people: {
      title: "People",
      subtitle: (repo: string) => `Authors in ${repo} for the selected range.`,
    },
    fair: {
      title: "Reading this fairly",
      teamSizes: "Team sizes differ. Authors in this range",
      authorsOf: (repo: string, count: number) => `${repo} ${count === 1 ? "has 1 author" : `has ${count} authors`}`,
      reviewSplit:
        "Reviewed and unreviewed pull requests are shown separately, because a solo author waits for nobody and would otherwise look fast.",
      ages: "Projects of different ages are best compared with Align to project start switched on.",
      overlap:
        "Period all were active compares the same calendar weeks, when every team was working at once; Align to project start compares each project's first weeks instead.",
      leadTime: "Lead time only counts pull requests merged after deploy runs were first observed for that repository.",
      partialWeek:
        "The current week is left off the weekly charts until it ends, so a week only two days old does not look like a slump.",
    },
  },

  home: {
    eyebrow: "Why we measure",
    title: "Deliver small changes often, and keep the code easy to change",
    lede: "This dashboard measures how work moves from a first commit to production, and how healthy the code is that it moves through. This page explains the ideas behind those figures, why they matter to the people who write the software, and how to read them without turning them into targets.",
    toRepos: "Go to your repositories",
    toKeys: "Start with the four keys",
    heroDiagram:
      "A change moves from commit to review, merge, deploy and the people who use it, and what they learn feeds back into the next commit.",
    pipeline: ["Commit", "Review", "Merge", "Deploy", "Users"],
    feedback: "Feedback",

    principlesTitle: "The short version",
    principles: [
      {
        title: "Speed and stability move together",
        body: "The DORA research programme has found, year after year, that teams who deploy more often also tend to fail less and recover sooner, so speed and safety are not a trade to be negotiated.",
      },
      {
        title: "Batch size is the lever",
        body: "Small pull requests are reviewed sooner, merged sooner and are easier to undo, which improves every one of the four keys at the same time.",
      },
      {
        title: "Simple code keeps it that way",
        body: "Code that is tested, clear and free of duplication stays cheap to change, and cheap change is what lets a team keep its pace as the system grows.",
      },
    ],

    doraEyebrow: "Delivery performance",
    doraTitle: "The four keys",
    doraLede:
      "The DevOps Research and Assessment programme, described in the book Accelerate and in the yearly State of DevOps reports, identified four measures that predict both software delivery performance and wider organisational outcomes. Two describe throughput and two describe stability, and they are most useful when read together.",
    groups: {
      throughput: {
        title: "Throughput",
        body: "How quickly a change can reach the people who use it.",
      },
      stability: {
        title: "Stability",
        body: "How often a change causes harm, and how quickly the team recovers.",
      },
    },
    measureLabels: {
      measures: "What we measure",
      why: "Why it matters",
      improve: "How to improve it",
    },
    measures: [
      {
        key: "frequency",
        group: "throughput",
        name: "Deployment frequency",
        question: "How often do we ship to production?",
        measures: "Successful runs of the deploy workflow on the deploy branch, counted per week.",
        why: "Frequent deploys mean each one carries less, so each is less risky and far easier to understand when something does go wrong.",
        improve:
          "Automate the path to production, keep the main branch releasable and hide unfinished work behind flags rather than on long-lived branches.",
      },
      {
        key: "lead",
        group: "throughput",
        name: "Lead time for changes",
        question: "How long does a change wait before it is live?",
        measures:
          "The median time from the first commit of a pull request to the end of the first successful deploy after it merged.",
        why: "Short lead time means fast feedback, because the sooner a change is in front of users the sooner the team learns whether it was the right change.",
        improve:
          "Open smaller pull requests, review within hours rather than days and remove manual gates that add waiting without adding safety.",
      },
      {
        key: "failure",
        group: "stability",
        name: "Change failure rate",
        question: "How often does a deploy go wrong?",
        measures: "Failed deploy runs as a share of all counted deploy runs.",
        why: "It keeps speed honest, since shipping faster only helps when the changes that are shipped still work.",
        improve:
          "Run meaningful tests on every change, review for behaviour rather than style and keep each deploy small enough to reason about.",
      },
      {
        key: "restore",
        group: "stability",
        name: "Time to restore",
        question: "When something breaks, how quickly do we recover?",
        measures: "The median time from the first failed deploy in a streak to the next successful one.",
        why: "Failure is unavoidable in any system that changes, so the ability to recover quickly matters more than the pretence of never failing.",
        improve:
          "Make rollback a single, rehearsed step, keep deploys small so the cause is obvious and fix forward only when that is genuinely quicker.",
      },
    ],

    flowTitle: "Where the time goes",
    flowLede:
      "Lead time is the sum of several waits. The dashboard splits it into the stages below, because the longest stage is usually a queue rather than work, and a queue is something a team can shorten by agreement.",
    flowDiagram:
      "An illustrative split of lead time into coding, waiting for review, in review, to merge and to deploy, where waiting for review is the longest stage.",
    flowIllustrative: "Illustrative proportions, not your data.",
    cycleTime: "Cycle time",
    leadTime: "Lead time",
    stages: [
      { key: "coding", name: "Coding", detail: "First commit to the pull request being opened." },
      { key: "waiting", name: "Waiting for review", detail: "Ready for review to the first review by someone else." },
      { key: "review", name: "In review", detail: "First review to approval." },
      { key: "merge", name: "To merge", detail: "Approval to the merge itself." },
      { key: "deploy", name: "To deploy", detail: "Merge to the end of the first successful deploy." },
    ],
    flowInsight:
      "In most teams the waiting stages are longer than the working ones. Reviewing a colleague's pull request before starting new work is often the quickest way to improve lead time for everyone.",

    bandsTitle: "Reading the bands",
    bandsLede:
      "Each measure is placed in one of four bands so a figure can be read at a glance. A band is always shown with its name as well as its colour, and it describes a team's system of work, never an individual.",
    bandsCaption: "The thresholds this dashboard uses for each DORA band, taken from the DORA 2023 profile.",
    bandsProfile:
      "These bands come from the DORA 2023 profile, which follows the clusters in the 2023 Accelerate State of DevOps Report. Every grade in the dashboard names the profile it used.",
    bandsSource: "Read the 2023 Accelerate State of DevOps Report",
    bandsSourceHref: "https://dora.dev/research/2023/dora-report/2023-dora-accelerate-state-of-devops-report.pdf",
    bandsMeasure: "Measure",
    bandRows: [
      {
        name: "Deployment frequency",
        elite: "7 or more a week",
        high: "1 or more a week",
        medium: "1 or more every four weeks",
        low: "Less often",
      },
      { name: "Lead time for changes", elite: "Under a day", high: "Under a week", medium: "Under a month", low: "Longer" },
      { name: "Change failure rate", elite: "5% or less", high: "10% or less", medium: "15% or less", low: "More" },
      { name: "Time to restore", elite: "Under an hour", high: "Under a day", medium: "Under a week", low: "Longer" },
    ],

    beckEyebrow: "Code quality",
    beckTitle: "Kent Beck's four rules of simple design",
    beckLede:
      "Delivery measures describe how fast change flows, but whether it can keep flowing depends on the code it flows through. Kent Beck's rules of simple design, summarised by Martin Fowler, give a short and practical definition of code that stays easy to change. The rules are given in priority order, so the first outweighs the others.",
    beckSource: "Read Beck Design Rules by Martin Fowler",
    beckMeasured: "What the dashboard measures",
    rules: [
      {
        name: "Passes the tests",
        body: "The software does what it is meant to do, and there are tests that prove it. Everything else rests on this rule, because without tests nobody can safely change the code in order to improve it.",
        measured:
          "Test ratio, the share of pull requests that include tests, whether CI runs the tests and whether a coverage floor is set.",
      },
      {
        name: "Reveals intention",
        body: "A reader can see what the code is for without tracing every path through it. Clear names and small, focused functions let the next person change the code with confidence.",
        measured: "Cyclomatic complexity per function, and the share of code that sits in heavily branching functions.",
      },
      {
        name: "No duplication",
        body: "Each piece of knowledge lives in one place, so a change is made once rather than hunted down in several. Removing duplication often reveals the abstraction that the design was missing.",
        measured:
          "Not measured directly. Duplication tends to surface as larger pull requests and recurring hotspots, and is best caught in review.",
      },
      {
        name: "Fewest elements",
        body: "Anything that does not serve the first three rules is removed. Speculative abstractions, unused options and layers added for a future that never arrives all make the code harder to read.",
        measured: "Long functions and functions with many parameters, which usually signal a function doing more than one job.",
      },
    ],

    loopTitle: "Why code quality shows up in the four keys",
    loopLede:
      "Code health and delivery performance are two views of the same system. The same forces that make code hard to read also make changes large, reviews slow and deploys risky, and each circle below tends to reinforce itself.",
    loops: {
      vicious: {
        title: "The vicious circle",
        steps: [
          "Complex, untested code",
          "Larger and riskier changes",
          "Slower reviews and more failed deploys",
          "Pressure to cut corners",
        ],
      },
      virtuous: {
        title: "The virtuous circle",
        steps: [
          "Simple, tested code",
          "Small and safe changes",
          "Quick reviews and quiet deploys",
          "Time to keep improving the code",
        ],
      },
    },

    practiceTitle: "Using these numbers well",
    practices: [
      {
        title: "Measure the system, not the person",
        body: "The figures describe how a team's way of working performs. Per-person views are off by default, because ranking people by throughput rewards work that looks small and safe and overlooks those who review, mentor and fix.",
      },
      {
        title: "Follow the trend, not the target",
        body: "When a measure becomes a target it stops being a good measure. Look for the direction of travel over several weeks, and ask what changed whenever a line moves.",
      },
      {
        title: "Read the four together",
        body: "Deploying more often while failures climb is not progress. A healthy improvement moves throughput and stability in the same direction.",
      },
      {
        title: "Compare like with like",
        body: "Teams differ in size, age and domain, so use the fairness options on the comparison view before drawing conclusions across repositories.",
      },
    ],

    readingTitle: "Further reading",
    reading: [
      {
        href: "https://martinfowler.com/bliki/BeckDesignRules.html",
        title: "Beck Design Rules",
        by: "Martin Fowler, on the four rules of simple design and why their order matters.",
      },
      {
        href: "https://martinfowler.com/articles/is-quality-worth-cost.html",
        title: "Is High Quality Software Worth the Cost?",
        by: "Martin Fowler, on why internal quality makes software cheaper to build, not dearer.",
      },
      {
        href: "https://dora.dev/",
        title: "DORA",
        by: "The research programme behind the four keys, with its reports, guides and quick check.",
      },
      {
        href: "https://itrevolution.com/product/accelerate/",
        title: "Accelerate",
        by: "Nicole Forsgren, Jez Humble and Gene Kim, on the science behind high-performing technology organisations.",
      },
    ],

    jira: {
      eyebrow: "Delivery from Jira",
      title: "Seeing the whole journey, from idea to production",
      lede: "Pull requests show how code moves, but they do not show how work moves. Measuring delivery from the tracker as well shows how work flows from idea to production, where it waits on the way, and whether the board tells the truth about what is happening. Each figure describes the team's system of work, and the dashboard hides people by default.",
      measures: [
        {
          name: "Issue cycle time",
          reveals:
            "How long finished work took from the day it was started to the day it was done, which shows how quickly a team can complete what it begins.",
        },
        {
          name: "Issue lead time",
          reveals:
            "How long a request waited from the day it was raised to the day it was done, which includes the time it sat before anyone began.",
        },
        {
          name: "Throughput",
          reveals:
            "How many items finish each week and of which type, which shows the steady rhythm of the team and any shift towards bugs or tasks.",
        },
        {
          name: "Work in progress and ageing work",
          reveals:
            "How much is under way at once and which items have been open longest, because work that is started but not finished is the usual place for delay to build up.",
        },
        {
          name: "Time per column",
          reveals:
            "Where finished items spent their time on the board, so a queue such as waiting for review can be seen and shortened by agreement.",
        },
        {
          name: "Flow efficiency",
          reveals:
            "How much of the time between started and done was spent actively worked rather than waiting, which is often lower than a team expects.",
        },
        {
          name: "Issue to first pull request and to production",
          reveals:
            "How long it takes for an idea to become code and then to reach users, measured only for items linked to a pull request.",
        },
        {
          name: "Hygiene checks",
          reveals:
            "Whether the board matches reality, for example whether pull requests name their issue and whether cards move when work starts. They make the other figures trustworthy, and they are prompts to tidy rather than a score.",
        },
      ],
      people:
        "People are hidden by default. A Show people switch on the page groups the hygiene lists by assignee name, and names never appear in charts or tiles.",
    },

    ctaTitle: "Put it into practice",
    ctaBody:
      "Add a repository to see its four keys, its flow and its code health side by side, then choose one small change to try this week.",
  },

  reviewQueue: {
    title: "Review queue",
    lede: "Open pull requests across your repositories, grouped by who has to act next. Waiting time counts weekdays only.",
    updated: (time: string) => `Updated ${time}`,
    refresh: "Refresh",
    refreshing: "Refreshing",
    refreshFailed: "The queue could not be refreshed. The figures shown are the last ones received.",
    copySummary: "Copy summary",
    /** Joins the title in the suggested PDF file name, as in review-queue-report-2026-09-30. */
    pdfLabel: "report",
    copied: "Summary copied to the clipboard",
    copyFailed: "The summary could not be copied",
    loading: "Loading the review queue",
    empty: "No open pull requests",
    emptyBody: "Nothing is waiting for review in the repositories being tracked.",
    noMatches: "No pull requests match these filters",
    readErrorTitle: (repo: string) => `Could not read ${repo}`,
    partialTitle: (repo: string) => `Only part of ${repo} was read`,
    readErrorBody: "Its pull requests are missing from this page. The other repositories are complete.",

    controls: {
      label: "Filters",
      repos: "Repositories",
      waitingOn: "Waiting on",
      anyone: "Anyone",
      search: "Search",
      searchPlaceholder: "Title, repository, number or ticket",
      drafts: "Show drafts and on hold",
      draftsHint: "Adds a column for pull requests that are not ready for review.",
      bots: "Show bot pull requests",
      botsHint: "Dependency updates and other automated changes.",
      names: "Show names",
      namesHint: "Names are hidden by default. Turn this on to see authors and requested reviewers.",
    },

    tiles: {
      waiting: "Waiting for review",
      waitingHint: (repos: number, held: number) =>
        `Across ${repos} ${repos === 1 ? "repository" : "repositories"}, with ${held} held back by failing checks`,
      pastDay: "Waiting over 24h",
      pastDayHint: (longest: string) => `Longest wait ${longest}`,
      noReviewer: "No reviewer requested",
      noReviewerHint: (oldest: string) => `Oldest has waited ${oldest}`,
      stale: "Stale, 5 weekdays or more",
      staleHint: (longest: string) => `Longest wait ${longest}`,
      fastLane: "Fast lane",
      fastLaneHint: "Waiting and under 400 changed lines across fewer than 10 files",
      idle: "Idle for 14 days or more",
      idleHint: "Open pull requests nobody has touched for two weeks",
      none: "None waiting",
    },

    attention: {
      title: "Needs attention",
      subtitle: "Stale pull requests and overdue pull requests with no reviewer, most urgent first.",
      empty: "Nothing needs urgent attention",
    },

    flag: {
      stale: "Stale",
      overdue: "Over 24h",
      noReviewer: "no reviewer",
      awaitingReview: "awaiting review",
    },

    wait: {
      underHour: "under 1h",
      hours: (n: number) => `${n}h`,
      weekdays: (n: number) => (n === 1 ? "1 weekday" : `${n} weekdays`),
    },

    features: {
      title: "Work split across pull requests",
      subtitle: "Pull requests that appear to belong to one piece of work, joined by a shared ticket, branch or stack.",
      evidence: {
        ticket: "Shared ticket",
        related: "Related line",
        branch: "Shared branch",
        stack: "Stacked",
      },
      members: (n: number) => `${n} pull requests`,
      longest: (wait: string) => `Longest wait ${wait}`,
    },

    repos: {
      title: "Waiting time by repository",
      subtitle: "How long each repository's waiting pull requests have been open, split into bands.",
      legendLabel: "Waiting time bands",
      weekendNote: "Waiting time leaves out weekends",
      cardSubtitle: (open: number) => `${open} open`,
      noWaiting: "Nothing waiting for review",
      segmentTitle: (band: string, count: number) => `${band}, ${count}`,
      barLabel: (repo: string) => `Waiting pull requests in ${repo} by waiting time`,
      tableBand: "Band",
      tableCount: "Waiting pull requests",
      lanesLine: (parts: string) => `Open now, ${parts}`,
    },

    bands: {
      stale: "Stale, 5 weekdays or more",
      overdue: "Over 24h",
      ageing: "4 to 24h",
      fresh: "Under 4h",
    },

    lanes: {
      no_reviewer: { title: "No reviewer", hint: "Nobody has been asked to review yet." },
      awaiting_review: { title: "Awaiting review", hint: "A reviewer has been asked and has not finished." },
      with_author: { title: "With the author", hint: "Failing checks or changes requested. The author acts next." },
      approved: { title: "Approved", hint: "Ready to merge." },
      held: { title: "Drafts and on hold", hint: "Not ready for review." },
      empty: "Nothing here",
      boardLabel: "Review queue lanes",
    },

    card: {
      opensInNewTab: "opens in a new tab",
      by: (author: string) => `by ${author}`,
      waitingSince: (wait: string) => `Waiting ${wait}`,
      waitingOn: (names: string) => `Waiting on ${names}`,
      reviewersRequested: (n: number) => `${n} ${n === 1 ? "reviewer" : "reviewers"} requested`,
      lines: (additions: number, deletions: number) => `+${additions} -${deletions}`,
      files: (files: number) => `${files} ${files === 1 ? "file" : "files"}`,
      checks: {
        passing: "Checks passing",
        failing: "Checks failing",
        pending: "Checks running",
        none: "No checks",
      },
      draft: "Draft",
      onHold: "On hold",
      idle: (days: number) => `Idle ${days} days`,
      authorAvatar: (login: string) => login,
    },

    summary: {
      heading: (count: number, repos: number) =>
        `Review queue, ${count} waiting across ${repos} ${repos === 1 ? "repository" : "repositories"}`,
      stale: (count: number) => `${count} stale`,
      pastDay: (count: number) => `${count} over 24h`,
      noReviewer: (count: number) => `${count} with no reviewer`,
      attention: "Needs attention",
      none: "Nothing needs urgent attention.",
      waitingOn: (names: string) => `waiting on ${names}`,
      by: (author: string) => `by ${author}`,
      footer: "Waiting time counts weekdays only.",
    },
  },

  states: {
    emptyTitle: "Nothing to show yet",
  },
} as const;

export type Copy = typeof copy;

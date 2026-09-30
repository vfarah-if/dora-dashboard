import type { FeatureGroup } from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatWait } from "../lib/reviewQueue";

const text = copy.reviewQueue;

export function FeatureCard({ feature }: { feature: FeatureGroup }) {
  return (
    <li className="card feature-card">
      <h4 className="feature-title">{feature.title}</h4>
      <p className="chart-subtitle">
        {text.features.members(feature.members.length)},{" "}
        {text.features.longest(formatWait(feature.longestWaitHours)).toLowerCase()}
      </p>
      <ul className="feature-evidence" aria-label={text.features.title}>
        {feature.evidence.map((kind) => (
          <li key={kind} className="pill">
            {text.features.evidence[kind]}
          </li>
        ))}
      </ul>
      <ul className="feature-members">
        {feature.members.map((member) => (
          <li key={member.key}>
            <a href={member.url} target="_blank" rel="noreferrer">
              {member.repo}#{member.number} {member.title}
              <span className="visually-hidden"> {text.card.opensInNewTab}</span>
            </a>
            <span className="feature-member-meta">
              {text.lanes[member.lane].title}, {formatWait(member.waitHours)}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

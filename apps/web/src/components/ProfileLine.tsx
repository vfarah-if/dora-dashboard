import type { RepoReport } from "@dora-dashboard/core";
import { copy } from "../copy";

/** Names the DORA profile the bands were graded against, linking to where its thresholds come from. */
export function ProfileLine({ profile }: { profile: RepoReport["dora"]["profile"] }) {
  return (
    <p className="profile-line">
      {copy.dora.profileLead}{" "}
      <a href={profile.source.url} target="_blank" rel="noopener noreferrer">
        {profile.name}
      </a>
      <span className="visually-hidden"> {copy.common.opensInNewTab}</span>
    </p>
  );
}

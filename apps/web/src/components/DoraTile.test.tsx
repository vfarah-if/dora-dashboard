import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DoraTile } from "./DoraTile";
import { copy } from "../copy";

describe("DoraTile", () => {
  it("prints the band as text beside the figure so band never relies on colour", () => {
    render(
      <DoraTile
        title={copy.dora.leadTime}
        definition={copy.dora.leadTimeDefinition}
        value="1.3 days"
        band="elite"
        detail="Across 4 shipped pull requests"
      />,
    );
    expect(screen.getByRole("heading", { name: copy.dora.leadTime })).toBeInTheDocument();
    expect(screen.getByText("1.3 days")).toBeInTheDocument();
    expect(screen.getByText("Elite")).toBeInTheDocument();
    expect(screen.getByText(copy.dora.leadTimeDefinition)).toBeInTheDocument();
  });

  it("says Not measured with the reason when the figure is missing", () => {
    render(
      <DoraTile
        title={copy.dora.deploymentFrequency}
        definition={copy.dora.deploymentFrequencyDefinition}
        value={null}
        band={null}
        reason={copy.dora.reasons.noWorkflow}
      />,
    );
    expect(screen.getByText(copy.dora.notMeasured)).toBeInTheDocument();
    expect(screen.getByText(copy.dora.reasons.noWorkflow)).toBeInTheDocument();
    expect(screen.queryByText(/Elite|High|Medium|Low/)).not.toBeInTheDocument();
  });
});

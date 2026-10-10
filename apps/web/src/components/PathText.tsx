import { Fragment } from "react";

/**
 * Text holding a path, which may wrap after each slash, so a narrow column or a printed page breaks it at folder
 * boundaries rather than mid-name or past the edge of its box. Any other slash in the text may wrap too.
 */
export function PathText({ text }: { text: string }) {
  const parts = text.split("/");
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </Fragment>
      ))}
    </>
  );
}

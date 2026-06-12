import { useCallback, useState } from "react";

const PRIMARY_COMMAND =
  "curl -fsSL https://tsforge.dev/install.sh | bash";

export default function InstallSnippet(): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(PRIMARY_COMMAND);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      setCopied(false);
    }
  }, []);

  return (
    <div className="tf-install-snippet">
      <p className="tf-install-snippet__label">Install</p>
      <div className="tf-install-snippet__row">
        <pre className="tf-install-snippet__code">
          <code>{PRIMARY_COMMAND}</code>
        </pre>
        <button
          type="button"
          className="tf-install-snippet__copy"
          aria-label={copied ? "Copied" : "Copy install command"}
          onClick={() => {
            void handleCopy();
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="tf-install-snippet__hint">
        Requires Bun ≥ 1.3.14.{" "}
        <a href="/quickstart/">Other install paths</a> (npm, from source).
      </p>
    </div>
  );
}

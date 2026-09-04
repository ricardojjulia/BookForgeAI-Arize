"use client";

import { useState } from "react";
import { Alert, Badge, Button, Checkbox, Group, NumberInput, Paper, Select, SimpleGrid, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useRouter } from "next/navigation";
import { GenerationProgressAlert } from "@/components/ai/generation-progress-alert";
import { fetchJson } from "@/lib/http/fetch-json";

type FinalManuscriptBuilderProps = {
  bookId: string;
  acceptedParagraphs: number;
  totalParagraphs: number;
  lockedParagraphs: number;
  /** Pending drafts awaiting accept/reject. 0 means the user has reviewed
   *  everything reviewable — if acceptedPercent is still < 90 they have
   *  hit the natural ceiling (short/structural paragraphs can't be rewritten). */
  pendingDraftCount: number;
  initialDefaults?: {
    format?: string;
    sourceMode?: string;
    includeFrontMatter?: boolean;
    includeBackMatter?: boolean;
    useOriginalForLocked?: boolean;
    abridgedMode?: boolean;
    epubMetadata?: {
      language?: string;
      publisher?: string;
      copyright?: string;
      description?: string;
    } | null;
    pdfOptions?: {
      fontSize?: number;
      lineGap?: number;
      pageNumbers?: boolean;
      pageSize?: "LETTER" | "A4";
    } | null;
  } | null;
};

type ExportResponse = {
  content?: {
    exportId: string;
    signedUrl: string | null;
    sourceMode: string;
    paragraphCount: number;
    chapterCount: number;
  };
};

type PreviewResponse = {
  content?: {
    previewText: string;
    truncated: boolean;
    warnings: string[];
    characterCount: number;
    paragraphCount: number;
    chapterCount: number;
  };
};

type ExportDefaults = {
  format: string;
  sourceMode: string;
  includeFrontMatter: boolean;
  includeBackMatter: boolean;
  useOriginalForLocked: boolean;
  abridgedMode: boolean;
  epubMetadata: {
    language?: string;
    publisher?: string;
    copyright?: string;
    description?: string;
  };
  pdfOptions: {
    fontSize?: number;
    lineGap?: number;
    pageNumbers: boolean;
    pageSize: "LETTER" | "A4";
  };
};

const RECOMMENDED_DEFAULTS: ExportDefaults = {
  format: "markdown",
  sourceMode: "accepted",
  includeFrontMatter: true,
  includeBackMatter: true,
  useOriginalForLocked: true,
  abridgedMode: false,
  epubMetadata: {
    language: "en",
    publisher: undefined,
    copyright: undefined,
    description: undefined,
  },
  pdfOptions: {
    fontSize: 11.5,
    lineGap: 3,
    pageNumbers: true,
    pageSize: "LETTER",
  },
};

export function FinalManuscriptBuilder({
  bookId,
  acceptedParagraphs,
  totalParagraphs,
  lockedParagraphs,
  pendingDraftCount,
  initialDefaults,
}: FinalManuscriptBuilderProps) {
  const router = useRouter();
  const lastUsedDefaults = toExportDefaults(initialDefaults);
  const [format, setFormat] = useState(lastUsedDefaults.format);
  const [sourceMode, setSourceMode] = useState(lastUsedDefaults.sourceMode);
  const [includeFrontMatter, setIncludeFrontMatter] = useState(lastUsedDefaults.includeFrontMatter);
  const [includeBackMatter, setIncludeBackMatter] = useState(lastUsedDefaults.includeBackMatter);
  const [useOriginalForLocked, setUseOriginalForLocked] = useState(lastUsedDefaults.useOriginalForLocked);
  const [abridgedMode, setAbridgedMode] = useState(lastUsedDefaults.abridgedMode);
  const [epubLanguage, setEpubLanguage] = useState(lastUsedDefaults.epubMetadata.language || "en");
  const [epubPublisher, setEpubPublisher] = useState(lastUsedDefaults.epubMetadata.publisher || "");
  const [epubCopyright, setEpubCopyright] = useState(lastUsedDefaults.epubMetadata.copyright || "");
  const [epubDescription, setEpubDescription] = useState(lastUsedDefaults.epubMetadata.description || "");
  const [pdfFontSize, setPdfFontSize] = useState<number | "">(typeof lastUsedDefaults.pdfOptions.fontSize === "number" ? lastUsedDefaults.pdfOptions.fontSize : 11.5);
  const [pdfLineGap, setPdfLineGap] = useState<number | "">(typeof lastUsedDefaults.pdfOptions.lineGap === "number" ? lastUsedDefaults.pdfOptions.lineGap : 3);
  const [pdfPageNumbers, setPdfPageNumbers] = useState(lastUsedDefaults.pdfOptions.pageNumbers);
  const [pdfPageSize, setPdfPageSize] = useState(lastUsedDefaults.pdfOptions.pageSize);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse["content"] | null>(null);
  const acceptedPercent = totalParagraphs ? Math.round((acceptedParagraphs / totalParagraphs) * 100) : 0;
  // When pendingDraftCount is 0 and coverage is still below 90%, the user has reviewed
  // everything reviewable. The gap is made up of short/structural paragraphs (< 8 words)
  // that the rewrite skips intentionally — this is the natural ceiling, not a work item.
  const atCeiling = pendingDraftCount === 0 && acceptedPercent < 90 && acceptedPercent > 0;
  const recommendation = getExportRecommendation({ acceptedPercent, lockedParagraphs, sourceMode, format, abridgedMode, atCeiling });

  function applyDefaults(defaults: ExportDefaults) {
    setFormat(defaults.format);
    setSourceMode(defaults.sourceMode);
    setIncludeFrontMatter(defaults.includeFrontMatter);
    setIncludeBackMatter(defaults.includeBackMatter);
    setUseOriginalForLocked(defaults.useOriginalForLocked);
    setAbridgedMode(defaults.abridgedMode);
    setEpubLanguage(defaults.epubMetadata.language || "en");
    setEpubPublisher(defaults.epubMetadata.publisher || "");
    setEpubCopyright(defaults.epubMetadata.copyright || "");
    setEpubDescription(defaults.epubMetadata.description || "");
    setPdfFontSize(typeof defaults.pdfOptions.fontSize === "number" ? defaults.pdfOptions.fontSize : 11.5);
    setPdfLineGap(typeof defaults.pdfOptions.lineGap === "number" ? defaults.pdfOptions.lineGap : 3);
    setPdfPageNumbers(defaults.pdfOptions.pageNumbers);
    setPdfPageSize(defaults.pdfOptions.pageSize);
  }

  function validateAndBuildPayload() {
    const normalizedLanguage = normalizeTextField(epubLanguage);
    if (normalizedLanguage && !/^[a-z]{2}(-[A-Z]{2})?$/.test(normalizedLanguage)) {
      setError("EPUB language must use BCP-47 short form like 'en' or 'en-US'.");
      return null;
    }

    if (format === "pdf") {
      if (typeof pdfFontSize === "number" && (pdfFontSize < 9 || pdfFontSize > 14)) {
        setError("PDF font size must be between 9 and 14.");
        return null;
      }
      if (typeof pdfLineGap === "number" && (pdfLineGap < 0 || pdfLineGap > 8)) {
        setError("PDF line spacing must be between 0 and 8.");
        return null;
      }
    }

    return {
      format,
      sourceMode,
      includeFrontMatter,
      includeBackMatter,
      useOriginalForLocked,
      abridgedMode,
      epubMetadata: {
        language: normalizedLanguage,
        publisher: normalizeTextField(epubPublisher),
        copyright: normalizeTextField(epubCopyright),
        description: normalizeTextField(epubDescription),
      },
      pdfOptions: {
        fontSize: typeof pdfFontSize === "number" ? pdfFontSize : undefined,
        lineGap: typeof pdfLineGap === "number" ? pdfLineGap : undefined,
        pageNumbers: pdfPageNumbers,
        pageSize: pdfPageSize,
      },
    };
  }

  async function buildExport() {
    const payload = validateAndBuildPayload();
    if (!payload) return;
    const warnings = getClientExportWarnings({ acceptedPercent, sourceMode, format, abridgedMode });
    if (warnings.length) {
      const confirmed = window.confirm(
        `Build this ${formatLabel(format)} export anyway?\n\n${warnings.join("\n")}\n\nPreview Assembly is recommended before exporting.`,
      );
      if (!confirmed) return;
    }
    setLoading(true);
    setMessage("");
    setError("");
    setDownloadUrl(null);
    try {
      const result = await fetchJson<ExportResponse>(
        `/api/books/${bookId}/export`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
        "Build final manuscript",
      );
      const content = result.content;
      setDownloadUrl(content?.signedUrl || null);
      setMessage(
        `${formatLabel(format)} manuscript built from ${content?.paragraphCount ?? totalParagraphs} paragraphs across ${
          content?.chapterCount ?? "all"
        } chapters.`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to build final manuscript.");
    } finally {
      setLoading(false);
    }
  }

  async function previewExport() {
    const payload = validateAndBuildPayload();
    if (!payload) return;
    setPreviewLoading(true);
    setMessage("");
    setError("");
    try {
      const result = await fetchJson<PreviewResponse>(
        `/api/books/${bookId}/export`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...payload,
            preview: true,
          }),
        },
        "Preview final manuscript",
      );
      setPreview(result.content || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to preview final manuscript.");
    } finally {
      setPreviewLoading(false);
    }
  }

  return (
    <Stack>
      <Paper withBorder radius="md" p="xl" bg="white">
        <Stack>
          <div>
            <Title order={2}>Build final manuscript</Title>
            <Text c="dimmed" size="sm">
              Create a book file from the manuscript structure. Original text is preserved; this only creates a new
              export.
            </Text>
          </div>
          <Paper withBorder radius="md" p="md" bg="#fffdf8">
            <Group justify="space-between" align="flex-start">
              <div>
                <Text fw={900}>Recommended Export Path</Text>
                <Text size="sm" c="dimmed">
                  {recommendation.description}
                </Text>
              </div>
              <Badge color={recommendation.color} variant="light">
                {recommendation.label}
              </Badge>
            </Group>
            <SimpleGrid cols={{ base: 1, md: 4 }} mt="md">
              <ExportChecklistItem
                done={acceptedPercent >= 90 || atCeiling}
                label="90%+ accepted"
                detail={atCeiling ? `${acceptedPercent}% — at ceiling` : `${acceptedPercent}% accepted`}
              />
              <ExportChecklistItem done={sourceMode === "accepted"} label="Accepted source" detail={sourceModeLabel(sourceMode)} />
              <ExportChecklistItem done={format === "docx" || acceptedPercent >= 90} label="Format fit" detail={formatHelp(format)} />
              <ExportChecklistItem done={!abridgedMode || preview?.warnings?.every((warning) => !warning.includes("Abridged")) !== false} label="Abridged check" detail={abridgedMode ? "cuts verified by preview" : "full-length"} />
            </SimpleGrid>
          </Paper>

          <Group grow align="flex-start">
            <Select
              label="Export format"
              description="DOCX is best for editing; Markdown is best for inspection."
              value={format}
              onChange={(value) => setFormat(value || "markdown")}
              data={[
                { value: "docx", label: "DOCX" },
                { value: "epub", label: "EPUB" },
                { value: "pdf", label: "PDF" },
                { value: "markdown", label: "Markdown" },
              ]}
            />
            <Select
              label="Text source"
              description="Accepted revisions are the safest default."
              value={sourceMode}
              onChange={(value) => setSourceMode(value || "accepted")}
              data={[
                { value: "accepted", label: "Accepted revisions only" },
                { value: "latest", label: "Latest draft revisions" },
                { value: "original", label: "Original manuscript" },
              ]}
            />
            <Paper withBorder radius="md" p="md" bg="gray.0">
              <Text fw={700}>Current manuscript state</Text>
              <Text size="sm" c="dimmed">
                <span suppressHydrationWarning>{acceptedParagraphs.toLocaleString()}</span> of{" "}
                <span suppressHydrationWarning>{totalParagraphs.toLocaleString()}</span> paragraphs have accepted
                revisions.
              </Text>
              <Text size="sm" c="dimmed">
                <span suppressHydrationWarning>{lockedParagraphs.toLocaleString()}</span> locked passage{lockedParagraphs === 1 ? "" : "s"} will use original
                text by default.
              </Text>
            </Paper>
          </Group>

          <Group>
            <Button variant="default" onClick={() => applyDefaults(lastUsedDefaults)}>
              Use last export settings
            </Button>
            <Button variant="default" onClick={() => applyDefaults(RECOMMENDED_DEFAULTS)}>
              Reset to recommended defaults
            </Button>
            <Checkbox
              checked={includeFrontMatter}
              onChange={(event) => setIncludeFrontMatter(event.currentTarget.checked)}
              label="Include front matter"
            />
            <Checkbox
              checked={includeBackMatter}
              onChange={(event) => setIncludeBackMatter(event.currentTarget.checked)}
              label="Include back matter"
            />
            <Checkbox
              checked={useOriginalForLocked}
              onChange={(event) => setUseOriginalForLocked(event.currentTarget.checked)}
              label="Use original text for locked passages"
            />
            <Checkbox
              checked={abridgedMode}
              onChange={(event) => setAbridgedMode(event.currentTarget.checked)}
              label="Build abridged edition from approved cuts"
            />
          </Group>

          {abridgedMode && (
            <Alert color="grape">
              Abridged mode excludes only approved abridgement cut suggestions. Original manuscript structure is not deleted.
            </Alert>
          )}

          {format === "epub" && (
            <Paper withBorder radius="md" p="md" bg="gray.0">
              <Title order={3} mb="sm">
                EPUB Metadata
              </Title>
              <Stack>
                <Group grow>
                  <TextInput label="Language" value={epubLanguage} onChange={(event) => setEpubLanguage(event.currentTarget.value)} />
                  <TextInput label="Publisher" value={epubPublisher} onChange={(event) => setEpubPublisher(event.currentTarget.value)} />
                </Group>
                <TextInput label="Copyright" value={epubCopyright} onChange={(event) => setEpubCopyright(event.currentTarget.value)} />
                <Textarea label="Description" value={epubDescription} onChange={(event) => setEpubDescription(event.currentTarget.value)} autosize minRows={2} />
              </Stack>
            </Paper>
          )}

          {format === "pdf" && (
            <Paper withBorder radius="md" p="md" bg="gray.0">
              <Title order={3} mb="sm">
                PDF Formatting
              </Title>
              <Group align="flex-start" grow>
                <Select
                  label="Page size"
                  value={pdfPageSize}
                  onChange={(value) => setPdfPageSize(value || "LETTER")}
                  data={[
                    { value: "LETTER", label: "Letter" },
                    { value: "A4", label: "A4" },
                  ]}
                />
                <NumberInput
                  label="Font size"
                  value={pdfFontSize}
                  min={9}
                  max={14}
                  step={0.5}
                  onChange={(value) => setPdfFontSize(typeof value === "number" ? value : "")}
                />
                <NumberInput
                  label="Line spacing"
                  value={pdfLineGap}
                  min={0}
                  max={8}
                  step={0.5}
                  onChange={(value) => setPdfLineGap(typeof value === "number" ? value : "")}
                />
              </Group>
              <Checkbox
                mt="sm"
                checked={pdfPageNumbers}
                onChange={(event) => setPdfPageNumbers(event.currentTarget.checked)}
                label="Show page numbers"
              />
            </Paper>
          )}

          {sourceMode === "latest" && (
            <Alert color="yellow">
              Latest draft mode can include revisions you have not accepted yet. Use it for preview exports, not final
              publishing.
            </Alert>
          )}
          {sourceMode === "original" && (
            <Alert color="blue">
              Original mode ignores accepted rewrites. Use it for archival exports or comparison copies.
            </Alert>
          )}
          {format === "epub" && sourceMode !== "accepted" && (
            <Alert color="yellow">
              EPUB is the Kindle/KDP review format. For a publishable EPUB, accepted revisions are the safest source.
            </Alert>
          )}

          <Group>
            <Button color="dark" variant="light" loading={previewLoading} onClick={previewExport}>
              Preview Assembly
            </Button>
            <Button color="grape" loading={loading} onClick={buildExport}>
              Build {formatLabel(format)}
            </Button>
            {downloadUrl && (
              <Button component="a" href={downloadUrl} target="_blank" rel="noreferrer" variant="light" color="teal">
                Download {formatLabel(format)}
              </Button>
            )}
          </Group>

          <GenerationProgressAlert
            active={previewLoading}
            message="Assembling preview..."
            estimatedSeconds={15}
            color="dark"
          />
          <GenerationProgressAlert
            active={loading}
            message={`Building ${formatLabel(format)} export...`}
            detail="a full manuscript can take a minute or more"
            estimatedSeconds={40}
            color="grape"
          />
          {message && <Alert color="green">{message}</Alert>}
          {error && <Alert color="red">{error}</Alert>}
          {preview && (
            <Paper withBorder radius="md" p="md" bg="gray.0">
              <Stack>
                <div>
                  <Title order={3}>Assembly Preview</Title>
                  <Text size="sm" c="dimmed">
                    {preview.paragraphCount.toLocaleString()} paragraphs across{" "}
                    {preview.chapterCount.toLocaleString()} chapters · {preview.characterCount.toLocaleString()}{" "}
                    characters{preview.truncated ? " · preview truncated" : ""}
                  </Text>
                </div>
                {preview.warnings.map((warning) => (
                  <Alert key={warning} color="yellow">
                    {warning}
                  </Alert>
                ))}
                <Textarea value={preview.previewText} readOnly autosize minRows={18} maxRows={34} />
              </Stack>
            </Paper>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}

function toExportDefaults(input: FinalManuscriptBuilderProps["initialDefaults"]): ExportDefaults {
  return {
    format: normalizeFormat(input?.format),
    sourceMode: normalizeSourceMode(input?.sourceMode),
    includeFrontMatter: input?.includeFrontMatter ?? RECOMMENDED_DEFAULTS.includeFrontMatter,
    includeBackMatter: input?.includeBackMatter ?? RECOMMENDED_DEFAULTS.includeBackMatter,
    useOriginalForLocked: input?.useOriginalForLocked ?? RECOMMENDED_DEFAULTS.useOriginalForLocked,
    abridgedMode: input?.abridgedMode ?? RECOMMENDED_DEFAULTS.abridgedMode,
    epubMetadata: {
      language: normalizeTextField(input?.epubMetadata?.language) || RECOMMENDED_DEFAULTS.epubMetadata.language,
      publisher: normalizeTextField(input?.epubMetadata?.publisher),
      copyright: normalizeTextField(input?.epubMetadata?.copyright),
      description: normalizeTextField(input?.epubMetadata?.description),
    },
    pdfOptions: {
      fontSize:
        typeof input?.pdfOptions?.fontSize === "number" && input.pdfOptions.fontSize >= 9 && input.pdfOptions.fontSize <= 14
          ? input.pdfOptions.fontSize
          : RECOMMENDED_DEFAULTS.pdfOptions.fontSize,
      lineGap:
        typeof input?.pdfOptions?.lineGap === "number" && input.pdfOptions.lineGap >= 0 && input.pdfOptions.lineGap <= 8
          ? input.pdfOptions.lineGap
          : RECOMMENDED_DEFAULTS.pdfOptions.lineGap,
      pageNumbers: input?.pdfOptions?.pageNumbers ?? RECOMMENDED_DEFAULTS.pdfOptions.pageNumbers,
      pageSize: input?.pdfOptions?.pageSize === "A4" ? "A4" : "LETTER",
    },
  };
}

function normalizeFormat(format: unknown): string {
  return ["markdown", "docx", "epub", "pdf"].includes(String(format || "")) ? String(format) : "markdown";
}

function normalizeSourceMode(sourceMode: unknown): string {
  return ["accepted", "latest", "original"].includes(String(sourceMode || "")) ? String(sourceMode) : "accepted";
}

function normalizeTextField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function formatLabel(format: string) {
  if (format === "epub") return "EPUB";
  if (format === "pdf") return "PDF";
  return format === "docx" ? "DOCX" : "Markdown";
}

function sourceModeLabel(sourceMode: string) {
  if (sourceMode === "latest") return "latest drafts";
  if (sourceMode === "original") return "original manuscript";
  return "accepted revisions";
}

function formatHelp(format: string) {
  if (format === "docx") return "editing handoff";
  if (format === "epub") return "Kindle/KDP review";
  if (format === "pdf") return "proof copy";
  return "inspection copy";
}

function getExportRecommendation({
  acceptedPercent,
  sourceMode,
  format,
  abridgedMode,
  atCeiling,
}: {
  acceptedPercent: number;
  lockedParagraphs: number;
  sourceMode: string;
  format: string;
  abridgedMode: boolean;
  atCeiling: boolean;
}) {
  if (acceptedPercent >= 90 && sourceMode === "accepted" && ["docx", "epub"].includes(format)) {
    return {
      label: "publishable path",
      color: "green",
      description: `${formatLabel(format)} from accepted revisions is the strongest current export path${abridgedMode ? " for the abridged edition" : ""}.`,
    };
  }
  // User has reviewed every reviewable paragraph — the remaining gap is structural
  // paragraphs (< 8 words: headings, scene breaks, short dialogue tags) that the
  // rewrite skips intentionally. This is the natural ceiling, not a work item.
  if (atCeiling && sourceMode === "accepted") {
    return {
      label: "ready to export",
      color: "green",
      description: `All rewriteable paragraphs have been accepted. The remaining ${100 - acceptedPercent}% are short structural elements (headings, scene breaks) that correctly use original text.`,
    };
  }
  if (format === "docx") {
    return {
      label: "editing copy",
      color: "blue",
      description: "DOCX is recommended when the manuscript still needs human editing or external review.",
    };
  }
  if (sourceMode !== "accepted") {
    return {
      label: "preview only",
      color: "yellow",
      description: "This source mode is useful for inspection, but accepted revisions are safer for final publication.",
    };
  }
  return {
    label: "review first",
    color: "yellow",
    description: "Preview assembly and resolve warnings before treating this as a final export.",
  };
}

function getClientExportWarnings({
  acceptedPercent,
  sourceMode,
  format,
  abridgedMode,
}: {
  acceptedPercent: number;
  sourceMode: string;
  format: string;
  abridgedMode: boolean;
}) {
  const warnings: string[] = [];
  if (sourceMode === "accepted" && acceptedPercent < 80) {
    warnings.push(`Only ${acceptedPercent}% of paragraphs have accepted revisions; the export will fall back to original text.`);
  }
  if (sourceMode === "latest") warnings.push("Latest mode can include unaccepted rewrite drafts.");
  if (["epub", "pdf"].includes(format) && acceptedPercent < 90) {
    warnings.push(`${formatLabel(format)} is usually best after 90%+ accepted coverage.`);
  }
  if (abridgedMode) warnings.push("Abridged mode depends on approved cut suggestions. Preview before exporting.");
  return warnings;
}

function ExportChecklistItem({ done, label, detail }: { done: boolean; label: string; detail: string }) {
  return (
    <Paper withBorder radius="sm" p="sm" bg={done ? "#eefbf4" : "white"}>
      <Group justify="space-between" gap="xs">
        <Text size="sm" fw={800}>
          {label}
        </Text>
        <Badge color={done ? "green" : "yellow"} variant="light">
          {done ? "ok" : "check"}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed">
        {detail}
      </Text>
    </Paper>
  );
}

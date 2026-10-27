// In-app snippet: convert STORED attachments into linked files, run inside the reference manager.
//
// This is the bulk migration half. The agent-side tool (tools/zotero-link-attachments.mjs) covers
// the increment - a few new PDFs per round - through the local API, under the owner's authorization.
// A whole-library migration is not a write this preset performs at all (protocol.md section 9),
// which is why this half exists: it runs in the application's own privileged context, at the
// owner's keyboard, with no API authorization involved at all.
//
// HOW TO RUN
//   1. Set CONFIG.targetDir below to the reference manager's linked-attachment base directory.
//   2. Open the reference manager, then Tools -> Developer -> Run JavaScript.
//   3. Paste this whole file and press Run (Ctrl+R).
//   4. Leave CONFIG.dryRun = true for the first run: it prints exactly what it would do.
//   5. Set CONFIG.dryRun = false and run it again to perform the moves.
//   6. Empty the trash afterwards - deleting the stored attachment does not free the disk by itself.
//
// WHAT IT DOES, per selected regular item (or the whole library when CONFIG.mode = 'library'):
//   * takes every STORED attachment (a PDF, or a snapshot when CONFIG.includeSnapshots is on);
//   * moves the payload file into CONFIG.targetDir, named after the item title;
//   * creates a linked-file attachment for it, and only then deletes the stored one;
//   * reports conflicts (a destination with different content) and skips them, never overwriting.
//
// Two differences from a copy-then-delete loop worth keeping: the file is MOVED, so the space is
// reclaimed as soon as the trash is emptied rather than after a second copy; and an item that
// already links the same file is recognised, so no duplicate link is created.
const CONFIG = {
  // SET THIS FIRST. The same directory the reference manager uses as its linked-attachment base
  // directory: a file under it is recorded as a relative path and survives moving to another machine.
  // The placeholder below stops the run before it touches anything.
  targetDir: '<the linked-attachment base directory>',
  // 'selected' converts the items selected in the main window; 'library' converts everything.
  mode: 'selected',
  // Snapshots are single self-contained .html files, so they move like any other payload.
  includeSnapshots: true,
  // Keep true until the printed plan matches what you expect.
  dryRun: true,
}

const LINKED_FILE = Zotero.Attachments.LINK_MODE_LINKED_FILE
const STORED_MODES = [Zotero.Attachments.LINK_MODE_IMPORTED_FILE, Zotero.Attachments.LINK_MODE_IMPORTED_URL]
const WANTED_TYPES = CONFIG.includeSnapshots ? ['application/pdf', 'text/html'] : ['application/pdf']

/** Strip what a filesystem rejects, and the trailing dots and spaces Windows drops anyway. */
function sanitizeFilename(title, fallback) {
  const cleaned = String(title ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return cleaned === '' ? fallback : cleaned
}

function extensionFor(contentType) {
  return contentType === 'application/pdf' ? 'pdf' : 'html'
}

/** Join a directory and a file name with this platform's separator. */
function destinationIn(dir, name) {
  const separator = Zotero.isWin ? '\\' : '/'
  return `${String(dir).replace(/[\\/]+$/, '')}${separator}${name}`
}

/** Whether the item already links the very file a destination names. */
async function itemLinksFile(item, destination) {
  for (const id of item.getAttachments()) {
    const attachment = Zotero.Items.get(id)
    if (attachment.attachmentLinkMode !== LINKED_FILE) continue
    const path = await attachment.getFilePathAsync()
    if (path && path.toLowerCase() === destination.toLowerCase()) return true
  }
  return false
}

/** Whether two files are byte-identical. Compares size first, then in 1 MiB chunks. */
async function filesEqual(pathA, pathB) {
  const a = await IOUtils.stat(pathA)
  const b = await IOUtils.stat(pathB)
  if (a.size !== b.size) return false
  const chunkSize = 1024 * 1024
  for (let offset = 0; offset < a.size; offset += chunkSize) {
    const maxBytes = Math.min(chunkSize, a.size - offset)
    const left = await IOUtils.read(pathA, { offset, maxBytes })
    const right = await IOUtils.read(pathB, { offset, maxBytes })
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return false
    }
  }
  return true
}

/** Move a file, falling back to copy-and-remove across volumes. */
async function moveFile(source, destination) {
  try {
    await IOUtils.move(source, destination)
    return 'moved'
  } catch (error) {
    await IOUtils.copy(source, destination)
    await IOUtils.remove(source)
    return 'copied'
  }
}

const counts = { converted: 0, recovered: 0, conflict: 0, redundant: 0, missing: 0, error: 0 }
const lines = []

if (String(CONFIG.targetDir).trim() === '' || String(CONFIG.targetDir).startsWith('<')) {
  return 'Set CONFIG.targetDir to the reference manager\'s linked-attachment base directory first.'
}

if (!(await IOUtils.exists(CONFIG.targetDir))) {
  return `Target directory does not exist: ${CONFIG.targetDir}`
}

const items =
  CONFIG.mode === 'library'
    ? (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).filter((item) => item.isRegularItem())
    : ZoteroPane.getSelectedItems().filter((item) => item.isRegularItem())

lines.push(`items: ${items.length} (mode=${CONFIG.mode}, dryRun=${CONFIG.dryRun})`)

for (const item of items) {
  const title = item.getField('title')
  for (const id of item.getAttachments()) {
    const attachment = Zotero.Items.get(id)
    if (!WANTED_TYPES.includes(attachment.attachmentContentType)) continue
    if (!STORED_MODES.includes(attachment.attachmentLinkMode)) continue

    const safeTitle = sanitizeFilename(title, attachment.key)
    const destination = destinationIn(
      CONFIG.targetDir,
      `${safeTitle}.${extensionFor(attachment.attachmentContentType)}`,
    )

    try {
      const source = await attachment.getFilePathAsync()
      if (!source || !(await IOUtils.exists(source))) {
        counts.missing += 1
        lines.push(`[missing]  ${safeTitle}: the stored file is not on disk`)
        continue
      }
      if (await IOUtils.exists(destination)) {
        if (await itemLinksFile(item, destination)) {
          counts.redundant += 1
          lines.push(`[redundant] ${safeTitle}: the item already links that file; delete the stored copy if you want the space`)
          continue
        }
        if (!(await filesEqual(source, destination))) {
          counts.conflict += 1
          lines.push(`[conflict]  ${safeTitle}: ${destination} exists with different content - left alone`)
          continue
        }
        // Same bytes, not yet linked: link it, then drop the duplicate stored copy.
        if (!CONFIG.dryRun) {
          await Zotero.Attachments.linkFromFile({
            file: destination,
            parentItemID: item.id,
            contentType: attachment.attachmentContentType,
            title: safeTitle,
          })
          attachment.deleted = true
          await attachment.saveTx()
        }
        counts.recovered += 1
        lines.push(`[recover]   ${safeTitle}: identical file already there, ${CONFIG.dryRun ? 'would link it' : 'linked'}`)
        continue
      }

      if (CONFIG.dryRun) {
        counts.converted += 1
        lines.push(`[convert]   ${safeTitle}: ${source} -> ${destination}`)
        continue
      }

      const how = await moveFile(source, destination)
      const linked = await Zotero.Attachments.linkFromFile({
        file: destination,
        parentItemID: item.id,
        contentType: attachment.attachmentContentType,
        title: safeTitle,
      })
      const readBack = await Zotero.Items.getAsync(linked.id)
      if (readBack.attachmentLinkMode !== LINKED_FILE || readBack.parentItemID !== item.id) {
        counts.error += 1
        lines.push(`[error]     ${safeTitle}: the new link did not read back as sent; the stored copy is kept`)
        continue
      }
      attachment.deleted = true
      await attachment.saveTx()
      counts.converted += 1
      lines.push(`[${how}]     ${safeTitle}`)
    } catch (error) {
      counts.error += 1
      lines.push(`[error]     ${safeTitle}: ${error}`)
    }
  }
}

const summary =
  `converted ${counts.converted}, recovered ${counts.recovered}, conflict ${counts.conflict}, ` +
  `redundant ${counts.redundant}, missing ${counts.missing}, error ${counts.error}`

if (!CONFIG.dryRun) {
  // A note save is what makes the application index the newly linked attachments: its background
  // index drain is otherwise only registered when a startup pass finds work pending.
  const notes = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).filter((item) => item.isNote())
  const marker = 'Autoresearch index refresh'
  const existing = notes.find((note) => note.getNote().includes(marker))
  const body = `<p>${marker} - safe to delete.</p>`
  if (existing) {
    existing.setNote(body)
    await existing.saveTx()
  } else {
    const note = new Zotero.Item('note')
    note.setNote(body)
    note.libraryID = Zotero.Libraries.userLibraryID
    await note.saveTx()
  }
}

const progress = new Zotero.ProgressWindow({ closeOnClick: true })
progress.changeHeadline(CONFIG.dryRun ? 'Attachment link migration (dry run)' : 'Attachment link migration')
progress.addDescription(summary)
progress.startCloseTimer(10000)
progress.show()

return `${CONFIG.dryRun ? 'DRY RUN - nothing was moved.\n' : ''}${summary}\n\n${lines.join('\n')}`

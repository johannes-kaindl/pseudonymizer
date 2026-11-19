# Pseudonymizer — documentation

The plugin is under construction and not published yet. Guides arrive with the first release.

## Getting started

The [README](../README.md) explains what the plugin protects and what it does not; read that first.
Everything below is a command in the command palette, and every value in the examples is invented.

1. **Set up.** Run *Set up*. The dialog tells you that your sync has to transfer files ending in `.pseudo` (the plugin cannot check that), lets you choose the language of the placeholders once for the whole vault (it cannot be changed later) and then shows the recovery code.
2. **Save the recovery code.** Put it in a password manager. The step goes on only after you confirm that you saved it. If every device and every saved code are lost, the placeholders can no longer be turned back into names; the notes stay readable. *Show recovery code* shows it again on any unlocked device.
3. **Add a further device.** Install the plugin there, let the table folder sync, then run *Enter recovery code* and paste the code. The device reads the existing files and writes its own. If the folder already holds device files, *Set up* points you to *Enter recovery code* instead of starting a new key.
4. **Use it.** *Pseudonymize this note* opens the review window; *Toggle plain text* switches the display per device. The README describes the rest under Usage.

## Troubleshooting

The messages below are the texts the plugin shows. Which one you see tells you what to do.

- **"Device files are here, but this device has no key yet."** The table was set up on another device. Run *Enter recovery code* with the code of that table.
- **"This device has a key, but the folder … holds no device file."** The folder was renamed or the files have not synced yet. Check the folder in the plugin settings, wait for the sync, or enter the recovery code. The settings also say that changing the folder does not move files: move the folder in Obsidian first.
- **"The device files in the folder … belong to another key."** Check the folder in the settings, or enter the recovery code of this table.
- **"The key of this device belongs to this table but opens none of the files."** The key is newer than every device file here. Wait until the files have synced, check the folder in the settings, or enter a newer recovery code.
- **"None of the device files … can be read."** They may be damaged or come from a newer version of the plugin. Update the plugin, and check the folder.
- **"The code was not saved. This code was replaced: another device set a new recovery code."** The key of the table was replaced on another device. Enter the new code instead; the old code was replaced. A device that still has the old key says "Another device has replaced the key of this table" and writes nothing more under the old key; entering the new code keeps what only this device knew.
- **"Not in the table on this device yet; another device may not have synced."** A placeholder is unknown here and stays a placeholder. Wait for the sync.
- **"Two devices wrote different values here; none is shown."** This is a conflict between two devices; the plugin shows neither value.
- **The notice "These properties were left unchanged because their values are not simple text or lists: …".** *Pseudonymize this note* only rewrites simple text and lists in properties. Nested values, block scalars and continuation lines are left byte for byte; the notice names them, so change those by hand.
- **After copying, a placeholder is still a placeholder.** Plain text goes out only where a placeholder is replaced anyway. In a link target, an image or bare URL, an HTML attribute, a comment, math, a wikilink or code it stays a placeholder, and the notice counts them ("… stayed as placeholders"). Forgotten placeholders stay placeholders as well. If this device cannot read a placeholder, nothing is copied ("Nothing was copied: this device cannot read …"); wait for the sync or copy with placeholders.
- **Obsidian Sync and the `.pseudo` files.** Whether Obsidian Sync transfers files with this extension is not measured yet.

## Getting help

Something missing or wrong? Open an issue in this repository with the Obsidian version and your platform.

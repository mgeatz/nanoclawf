-- Post a tweet to Twitter/X
-- Uses: clipboard (pbcopy) + System Events (Cmd+V, Cmd+Enter)
-- Requires: macOS Accessibility permission for the NanoClaw process
-- Works with any browser (default browser)

on run argv
	set tweetText to item 1 of argv

	-- Set clipboard to tweet text
	set the clipboard to tweetText

	-- Open Twitter compose in default browser
	do shell script "open 'https://x.com/compose/post'"

	-- Wait for page to load and compose box to auto-focus
	delay 5

	tell application "System Events"
		-- Paste tweet text from clipboard
		keystroke "v" using command down
		delay 2
		-- Post with Cmd+Enter
		keystroke return using command down
	end tell

	delay 2
	return "POSTED"
end run

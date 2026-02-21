-- Search the web using Perplexity AI
-- Opens Perplexity in the default browser, waits for the AI answer, extracts text
-- Arguments: searchURL (full Perplexity URL with encoded query)
-- Supports: Safari, Google Chrome, Arc, Brave, Edge (Chromium browsers)
-- Requires: macOS Accessibility permission; Safari needs Develop > Allow JavaScript from Apple Events
--
-- NOTE: Safari uses direct do JavaScript. Chrome/Arc/others use osascript subprocess
-- to avoid compile-time dictionary dependency (script won't compile if app isn't installed).

on run argv
	set searchURL to item 1 of argv

	-- Open the Perplexity search URL in default browser
	do shell script "open '" & searchURL & "'"

	-- Wait for page to load
	delay 8

	-- Detect which browser is frontmost
	tell application "System Events"
		set frontApp to name of first application process whose frontmost is true
	end tell

	-- Map to browser name for execJS
	set browserName to "Safari"
	if frontApp contains "Chrome" then
		set browserName to "Google Chrome"
	else if frontApp contains "Arc" then
		set browserName to "Arc"
	else if frontApp contains "Brave" then
		set browserName to "Brave Browser"
	else if frontApp contains "Edge" then
		set browserName to "Microsoft Edge"
	end if

	-- Quick test: can we execute JavaScript in this browser?
	set jsTest to my execJS(browserName, "'JSOK'")
	set useClipboard to (jsTest is not "JSOK")

	if useClipboard then
		-- JS execution not available (e.g. Safari needs Develop > Allow JavaScript from Apple Events)
		-- Fallback: wait for Perplexity to finish generating, then select-all + copy
		delay 18

		-- Save current clipboard
		set oldClip to the clipboard

		tell application "System Events"
			keystroke "a" using command down
			delay 0.5
			keystroke "c" using command down
			delay 1
		end tell

		set answerText to the clipboard

		-- Restore old clipboard
		set the clipboard to oldClip

		if (length of answerText) < 50 then
			set answerText to "NO_CONTENT_FOUND"
		end if
	else
		-- JavaScript works — use precise DOM extraction
		set checkLenJS to "(function(){var m=0;document.querySelectorAll('[class*=prose]').forEach(function(e){var l=(e.innerText||'').length;if(l>m)m=l;});if(m>0)return String(m);var mn=document.querySelector('main');if(mn)return String((mn.innerText||'').length);return '0';})()"

		set extractJS to "(function(){var b='';document.querySelectorAll('[class*=prose]').forEach(function(e){var t=(e.innerText||'').trim();if(t.length>b.length)b=t;});if(b.length<50){document.querySelectorAll('[class*=markdown],[class*=answer]').forEach(function(e){var t=(e.innerText||'').trim();if(t.length>b.length)b=t;});}if(b.length<50){var m=document.querySelector('main');if(m){var t=(m.innerText||'').trim();if(t.length>b.length)b=t;}}return b||'NO_CONTENT_FOUND';})()"

		-- Poll until content stabilizes (same length for 2 consecutive checks)
		set lastLen to "0"
		set stableCount to 0

		repeat 12 times
			set currentLen to my execJS(browserName, checkLenJS)

			if currentLen is not "0" and currentLen is lastLen then
				set stableCount to stableCount + 1
				if stableCount >= 2 then exit repeat
			else
				set stableCount to 0
			end if

			set lastLen to currentLen
			delay 3
		end repeat

		-- Extract the full answer text
		set answerText to my execJS(browserName, extractJS)

		-- If JS extraction still returned nothing, try clipboard fallback
		if answerText is "0" or answerText is "" then
			delay 1
			set oldClip to the clipboard
			tell application "System Events"
				keystroke "a" using command down
				delay 0.5
				keystroke "c" using command down
				delay 1
			end tell
			set answerText to the clipboard
			set the clipboard to oldClip
			if (length of answerText) < 50 then
				set answerText to "NO_CONTENT_FOUND"
			end if
		end if
	end if

	-- Close the Perplexity tab to avoid accumulating tabs
	delay 1
	if browserName is "Safari" then
		tell application "Safari"
			try
				close current tab of front window
			end try
		end tell
	else
		try
			tell application "System Events"
				keystroke "w" using command down
			end tell
		end try
	end if

	return answerText
end run

-- Execute JavaScript in the frontmost browser
-- Safari: direct do JavaScript (always available on macOS)
-- Chrome/Arc/others: via osascript subprocess to avoid compile-time dictionary dependency
on execJS(browserName, jsCode)
	if browserName contains "Safari" then
		tell application "Safari"
			try
				return do JavaScript jsCode in current tab of front window
			on error
				return "0"
			end try
		end tell
	else
		try
			do shell script "printf '%s' " & quoted form of jsCode & " > /tmp/nc-browser-exec.js"
			set e1 to "set js to read POSIX file \"/tmp/nc-browser-exec.js\""
			set e2 to "tell application \"" & browserName & "\" to execute active tab of front window javascript js"
			return do shell script "osascript -e " & quoted form of e1 & " -e " & quoted form of e2
		on error
			return "0"
		end try
	end if
end execJS

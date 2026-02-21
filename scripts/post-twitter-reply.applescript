-- Reply to a specific tweet on Twitter/X
-- Uses: clipboard + browser-specific JavaScript execution
-- Arguments: replyText (the reply content), tweetURL (full tweet URL)
-- Supports: Safari, Google Chrome, Arc, Brave, Edge (Chromium browsers)
-- Requires: macOS Accessibility permission; Safari needs Develop > Allow JavaScript from Apple Events

on run argv
	set replyText to item 1 of argv
	set tweetURL to item 2 of argv

	-- Set clipboard to reply text
	set the clipboard to replyText

	-- Open the specific tweet in default browser
	do shell script "open '" & tweetURL & "'"

	-- Wait for page to load
	delay 5

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

	-- Verify we landed on Twitter/X
	set urlCheckJS to "(function(){return window.location.hostname;})()"
	set currentHost to my execJS(browserName, urlCheckJS)
	if currentHost is not "x.com" and currentHost is not "twitter.com" and currentHost is not "mobile.twitter.com" then
		-- JS might not work; fallback: check via browser URL bar
		if currentHost is "JS_ERROR" then
			-- Can't verify, proceed with caution
			set currentHost to "unknown"
		else
			return "ERROR: Browser navigated to " & currentHost & " instead of x.com. The URL may not be a valid tweet."
		end if
	end if

	-- JavaScript to find and click the Reply button on the tweet
	set clickReplyJS to "
(function() {
  var replyBtns = document.querySelectorAll('[data-testid=\"reply\"]');
  if (replyBtns.length > 0) {
    replyBtns[0].click();
    return 'CLICKED_REPLY';
  }
  var ariaReply = document.querySelector('[aria-label=\"Reply\"]');
  if (ariaReply) {
    ariaReply.click();
    return 'CLICKED_REPLY';
  }
  return 'REPLY_NOT_FOUND';
})()
"

	-- JavaScript to click the Post/Reply submit button in the compose modal
	set submitJS to "
(function() {
  var postBtn = document.querySelector('[data-testid=\"tweetButtonInline\"]');
  if (postBtn) {
    postBtn.click();
    return 'SUBMITTED';
  }
  postBtn = document.querySelector('[data-testid=\"tweetButton\"]');
  if (postBtn) {
    postBtn.click();
    return 'SUBMITTED';
  }
  return 'SUBMIT_NOT_FOUND';
})()
"

	-- Click the reply button to open compose
	set clickResult to my execJS(browserName, clickReplyJS)
	if clickResult is "JS_ERROR" then
		-- Fallback: press 'r' which is Twitter's keyboard shortcut for reply
		tell application "System Events"
			keystroke "r"
		end tell
		set clickResult to "FALLBACK_KEYSTROKE"
	end if

	if clickResult is "REPLY_NOT_FOUND" then
		return "ERROR: Could not find Reply button. Make sure the tweet URL is correct and you are logged in."
	end if

	-- Wait for reply compose box to open
	delay 2

	-- Paste reply text from clipboard
	tell application "System Events"
		keystroke "v" using command down
	end tell

	-- Wait for text to be pasted
	delay 2

	-- Click the Post button to submit the reply
	set submitResult to my execJS(browserName, submitJS)
	if submitResult is "JS_ERROR" then
		-- Fallback: Cmd+Enter to submit
		tell application "System Events"
			keystroke return using command down
		end tell
		set submitResult to "FALLBACK_SUBMIT"
	end if

	if submitResult is "SUBMIT_NOT_FOUND" then
		return "ERROR: Reply text pasted but could not find Post button. Please submit manually."
	end if

	delay 2
	if submitResult is "FALLBACK_SUBMIT" then
		return "UNVERIFIED: Used keyboard shortcut to submit. Could not confirm post was published."
	end if
	return "POSTED"
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
				return "JS_ERROR"
			end try
		end tell
	else
		try
			do shell script "printf '%s' " & quoted form of jsCode & " > /tmp/nc-browser-exec.js"
			set e1 to "set js to read POSIX file \"/tmp/nc-browser-exec.js\""
			set e2 to "tell application \"" & browserName & "\" to execute active tab of front window javascript js"
			return do shell script "osascript -e " & quoted form of e1 & " -e " & quoted form of e2
		on error
			return "JS_ERROR"
		end try
	end if
end execJS

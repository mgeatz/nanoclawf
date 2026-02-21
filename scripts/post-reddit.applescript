-- Post a comment on a Reddit post
-- Uses: clipboard + browser-specific JavaScript execution
-- Arguments: commentText (the comment body), postURL (full Reddit post URL)
-- Supports: Safari, Google Chrome, Arc, Brave, Edge (Chromium browsers)
-- Requires: macOS Accessibility permission; Safari needs Develop > Allow JavaScript from Apple Events

on run argv
	set commentText to item 1 of argv
	set postURL to item 2 of argv

	-- Set clipboard to comment text
	set the clipboard to commentText

	-- Open the specific Reddit post in default browser
	do shell script "open '" & postURL & "'"

	-- Wait for page to load
	delay 6

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

	-- Verify we landed on Reddit
	set urlCheckJS to "(function(){return window.location.hostname;})()"
	set currentHost to my execJS(browserName, urlCheckJS)
	if currentHost does not contain "reddit.com" then
		if currentHost is not "JS_ERROR" then
			return "ERROR: Browser navigated to " & currentHost & " instead of reddit.com. The URL may not be a valid Reddit post."
		end if
	end if

	-- JavaScript to focus the comment box and scroll to it
	set focusJS to "
(function() {
  var composer = document.querySelector('shreddit-composer');
  if (composer) {
    var shadow = composer.shadowRoot;
    if (shadow) {
      var editor = shadow.querySelector('[contenteditable=\"true\"]');
      if (editor) {
        editor.scrollIntoView({behavior: 'smooth', block: 'center'});
        editor.focus();
        editor.click();
        return 'FOCUSED_SHREDDIT';
      }
    }
  }
  var editables = document.querySelectorAll('div[contenteditable=\"true\"]');
  for (var i = 0; i < editables.length; i++) {
    var el = editables[i];
    if (el.offsetHeight > 20 && el.offsetWidth > 100) {
      el.scrollIntoView({behavior: 'smooth', block: 'center'});
      el.focus();
      el.click();
      return 'FOCUSED_CONTENTEDITABLE';
    }
  }
  var textareas = document.querySelectorAll('textarea');
  for (var i = 0; i < textareas.length; i++) {
    var ta = textareas[i];
    var placeholder = (ta.placeholder || '').toLowerCase();
    if (placeholder.indexOf('comment') !== -1 || placeholder.indexOf('thought') !== -1 || ta.name === 'text') {
      ta.scrollIntoView({behavior: 'smooth', block: 'center'});
      ta.focus();
      ta.click();
      return 'FOCUSED_TEXTAREA';
    }
  }
  return 'NOT_FOUND';
})()
"

	-- JavaScript to click the Comment/Submit button
	set submitJS to "
(function() {
  var submitBtn = document.querySelector('button[slot=\"submit-button\"]');
  if (submitBtn && submitBtn.offsetParent !== null) {
    submitBtn.click();
    return 'SUBMITTED';
  }
  var buttons = document.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    var txt = buttons[i].textContent.trim();
    if (txt === 'Comment' && buttons[i].offsetParent !== null) {
      buttons[i].click();
      return 'SUBMITTED';
    }
  }
  var oldSubmit = document.querySelector('button[type=\"submit\"].save');
  if (oldSubmit) {
    oldSubmit.click();
    return 'SUBMITTED';
  }
  return 'SUBMIT_NOT_FOUND';
})()
"

	-- Execute focus JS via execJS handler
	set focusResult to my execJS(browserName, focusJS)
	if focusResult is "JS_ERROR" then
		-- Fallback: tab to comment box
		tell application "System Events"
			repeat 5 times
				keystroke tab
				delay 0.3
			end repeat
		end tell
		set focusResult to "FALLBACK_TAB"
	end if

	if focusResult is "NOT_FOUND" then
		return "ERROR: Could not find comment box. Make sure you are logged in to Reddit."
	end if

	-- Small delay for focus to settle
	delay 1

	-- Paste comment text from clipboard
	tell application "System Events"
		keystroke "v" using command down
	end tell

	-- Wait for text to be pasted
	delay 2

	-- Click the Comment button via execJS handler
	set submitResult to my execJS(browserName, submitJS)
	if submitResult is "JS_ERROR" then
		-- Fallback: try Cmd+Enter
		tell application "System Events"
			keystroke return using command down
		end tell
		set submitResult to "FALLBACK_SUBMIT"
	end if

	if submitResult is "SUBMIT_NOT_FOUND" then
		return "ERROR: Comment pasted but could not find Submit button. Please submit manually."
	end if

	delay 2
	if submitResult is "FALLBACK_SUBMIT" then
		return "UNVERIFIED: Used keyboard shortcut to submit. Could not confirm comment was posted."
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

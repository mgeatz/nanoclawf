-- Send a direct message to a Reddit user
-- Uses: clipboard + browser-specific JavaScript execution
-- Arguments: messageText (the DM body), targetUsername (Reddit username without u/)
-- Supports: Safari, Google Chrome, Arc, Brave, Edge (Chromium browsers)
-- Requires: macOS Accessibility permission; Safari needs Develop > Allow JavaScript from Apple Events
-- Note: Uses old Reddit message compose which is more reliable for automation

on run argv
	set messageText to item 1 of argv
	set targetUsername to item 2 of argv

	-- Set clipboard to message text
	set the clipboard to messageText

	-- Open the Reddit message compose page with recipient pre-filled
	set composeURL to "https://www.reddit.com/message/compose/?to=" & targetUsername
	do shell script "open '" & composeURL & "'"

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
			return "ERROR: Browser navigated to " & currentHost & " instead of reddit.com."
		end if
	end if

	-- JavaScript to fill in the subject and focus the message textarea
	set fillJS to "
(function() {
  var subjectInput = document.querySelector('input[name=\"subject\"]');
  if (!subjectInput) {
    subjectInput = document.querySelector('input[placeholder*=\"Subject\"]');
  }
  if (!subjectInput) {
    var inputs = document.querySelectorAll('input[type=\"text\"]');
    for (var i = 0; i < inputs.length; i++) {
      var ph = (inputs[i].placeholder || '').toLowerCase();
      if (ph.indexOf('subject') !== -1) {
        subjectInput = inputs[i];
        break;
      }
    }
  }
  if (subjectInput) {
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(subjectInput, 'Hello from Launch80');
    subjectInput.dispatchEvent(new Event('input', {bubbles: true}));
    subjectInput.dispatchEvent(new Event('change', {bubbles: true}));
  }
  var msgArea = document.querySelector('textarea[name=\"message\"]');
  if (!msgArea) {
    msgArea = document.querySelector('textarea[placeholder*=\"Message\"]');
  }
  if (!msgArea) {
    var textareas = document.querySelectorAll('textarea');
    for (var i = 0; i < textareas.length; i++) {
      var ph = (textareas[i].placeholder || '').toLowerCase();
      if (ph.indexOf('message') !== -1 || textareas[i].name === 'message' || textareas[i].name === 'text') {
        msgArea = textareas[i];
        break;
      }
    }
  }
  if (!msgArea) {
    var editables = document.querySelectorAll('div[contenteditable=\"true\"]');
    for (var i = 0; i < editables.length; i++) {
      if (editables[i].offsetHeight > 30 && editables[i].offsetWidth > 100) {
        editables[i].scrollIntoView({behavior: 'smooth', block: 'center'});
        editables[i].focus();
        editables[i].click();
        return 'FOCUSED_CONTENTEDITABLE';
      }
    }
  }
  if (msgArea) {
    msgArea.scrollIntoView({behavior: 'smooth', block: 'center'});
    msgArea.focus();
    msgArea.click();
    return 'FOCUSED_TEXTAREA';
  }
  return 'NOT_FOUND';
})()
"

	-- JavaScript to click the Send button
	set sendJS to "
(function() {
  var buttons = document.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    var txt = buttons[i].textContent.trim().toLowerCase();
    if ((txt === 'send' || txt === 'submit' || txt === 'send message') && buttons[i].offsetParent !== null) {
      buttons[i].click();
      return 'SENT';
    }
  }
  var submitBtn = document.querySelector('button[type=\"submit\"]');
  if (submitBtn && submitBtn.offsetParent !== null) {
    submitBtn.click();
    return 'SENT';
  }
  var inputSubmit = document.querySelector('input[type=\"submit\"]');
  if (inputSubmit) {
    inputSubmit.click();
    return 'SENT';
  }
  return 'SEND_NOT_FOUND';
})()
"

	-- Execute fill JS via execJS handler
	set focusResult to my execJS(browserName, fillJS)
	if focusResult is "JS_ERROR" then
		-- Fallback: tab to message area
		tell application "System Events"
			repeat 5 times
				keystroke tab
				delay 0.3
			end repeat
		end tell
		set focusResult to "FALLBACK_TAB"
	end if

	if focusResult is "NOT_FOUND" then
		return "ERROR: Could not find message compose form. Make sure you are logged in to Reddit."
	end if

	-- Small delay for focus to settle
	delay 1

	-- Paste message text from clipboard
	tell application "System Events"
		keystroke "v" using command down
	end tell

	-- Wait for text to be pasted
	delay 2

	-- Click the Send button via execJS handler
	set sendResult to my execJS(browserName, sendJS)
	if sendResult is "JS_ERROR" then
		-- Fallback: try Cmd+Enter
		tell application "System Events"
			keystroke return using command down
		end tell
		set sendResult to "FALLBACK_SUBMIT"
	end if

	if sendResult is "SEND_NOT_FOUND" then
		return "ERROR: Message pasted but could not find Send button. Please send manually."
	end if

	delay 2
	if sendResult is "FALLBACK_SUBMIT" then
		return "UNVERIFIED: Used keyboard shortcut to send. Could not confirm DM was delivered."
	end if
	return "SENT"
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

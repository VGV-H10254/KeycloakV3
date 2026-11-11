<#import "template.ftl" as layout>
<#import "password-commons.ftl" as passwordCommons>
<@layout.registrationLayout; section>
<#--
  Override von Keycloak 26.7 `theme/base/login/login-recovery-authn-code-config.ftl`.

  Warum dieser Override (FR-36 / FR-39, Entscheidung "Option B" vom 2026-10-23):
  Der Recovery-Einstieg verlangt zuerst die Kennung (Keycloak-Username = verifi_id) und
  danach einen Einmalcode. Die Kennung ist fuer Endnutzer nicht ableitbar, deshalb muss sie
  zusammen mit den Einmalcodes aufbewahrt werden. Keycloak stellt auf dieser Seite kein
  User-Objekt im FreeMarker-Modell bereit (FreeMarkerLoginFormsProvider.createResponse put
  fuer LOGIN_RECOVERY_AUTHN_CODES_CONFIG nur `recoveryAuthnCodesConfigBean`), der Wert kann
  hier also nicht gerendert werden. Der Override zieht deshalb das Codeblatt und die Kennung
  sichtbar zusammen: Schreibfeld auf der Seite, in der Druckansicht und im Download.

  Hinweis: Texte sind bewusst Literaltext (kein msg()), weil das Produkt deutschsprachig ist
  (NFR-UX-01) und die Brand-Themes nur messages_de.properties mitbringen. Ein msg()-Key
  wuerde in der Sprachvariante "en" als "!!key!!" erscheinen.
-->
<#if section = "header">
    ${msg("recovery-code-config-header")}
<#elseif section = "form">
    <!-- warning -->
    <div class="pf-c-alert pf-m-warning pf-m-inline ${properties.kcRecoveryCodesWarning!}" aria-label="Warning alert">
        <div class="pf-c-alert__icon">
            <i class="pficon-warning-triangle-o" aria-hidden="true"></i>
        </div>
        <h4 class="pf-c-alert__title">
            <span class="pf-screen-reader">Warning alert:</span>
            ${msg("recovery-code-config-warning-title")}
        </h4>
        <div class="pf-c-alert__description">
            <p>${msg("recovery-code-config-warning-message")}</p>
        </div>
    </div>

    <!-- Kennung gehoert zum Codeblatt (Option B) -->
    <div class="pf-c-alert pf-m-info pf-m-inline" aria-label="Hinweis zur Kennung">
        <div class="pf-c-alert__icon">
            <i class="pficon-info" aria-hidden="true"></i>
        </div>
        <h4 class="pf-c-alert__title">
            <span class="pf-screen-reader">Hinweis:</span>
            Diese Einmalcodes gelten nur zusammen mit Ihrer Kennung
        </h4>
        <div class="pf-c-alert__description">
            <p>
                Ihre Kennung ist die Nummer, die Sie im Portal unter &bdquo;Ihre Kennung&ldquo; gesehen
                haben (Beispiel: <span style="font-family: monospace">V-1234567</span>).
                Ohne diese Kennung lassen sich die Einmalcodes nicht einl&ouml;sen.
            </p>
            <p style="font-family: monospace; margin-top: 12px">
                Kennung: ________________________________
            </p>
        </div>
    </div>

    <ol id="kc-recovery-codes-list" class="${properties.kcRecoveryCodesList!}">
        <#list recoveryAuthnCodesConfigBean.generatedRecoveryAuthnCodesList as code>
            <li><span>${code?counter}:</span> ${code[0..3]}-${code[4..7]}-${code[8..]}</li>
        </#list>
    </ol>

    <!-- actions -->
    <div class="${properties.kcRecoveryCodesActions!}">
        <button id="printRecoveryCodes" class="pf-c-button pf-m-link" type="button">
            <i class="pficon-print"></i> ${msg("recovery-codes-print")}
        </button>
        <button id="downloadRecoveryCodes" class="pf-c-button pf-m-link" type="button">
            <i class="pficon-save"></i> ${msg("recovery-codes-download")}
        </button>
        <button id="copyRecoveryCodes" class="pf-c-button pf-m-link" type="button">
            <i class="pficon-blueprint"></i> ${msg("recovery-codes-copy")}
        </button>
    </div>

    <!-- confirmation checkbox -->
    <div class="${properties.kcFormOptionsClass!}">
        <input class="${properties.kcCheckInputClass!}" type="checkbox" id="kcRecoveryCodesConfirmationCheck" name="kcRecoveryCodesConfirmationCheck"
        onchange="document.getElementById('saveRecoveryAuthnCodesBtn').disabled = !this.checked;"
        />
        <label for="kcRecoveryCodesConfirmationCheck">${msg("recovery-codes-confirmation-message")}</label>
    </div>

    <form action="${url.loginAction}" class="${properties.kcFormGroupClass!}" id="kc-recovery-codes-settings-form" method="post">
        <input type="hidden" name="generatedRecoveryAuthnCodes" value="${recoveryAuthnCodesConfigBean.generatedRecoveryAuthnCodesAsString}" />
        <input type="hidden" name="generatedAt" value="${recoveryAuthnCodesConfigBean.generatedAt?c}" />
        <input type="hidden" id="userLabel" name="userLabel" value="${msg("recovery-codes-label-default")}" />
        <@passwordCommons.logoutOtherSessions/>

        <#if isAppInitiatedAction??>
            <input type="submit"
            class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonLargeClass!}"
            id="saveRecoveryAuthnCodesBtn" value="${msg("recovery-codes-action-complete")}"
            disabled
            />
            <button type="submit"
                class="${properties.kcButtonClass!} ${properties.kcButtonDefaultClass!} ${properties.kcButtonLargeClass!} ${properties.kcButtonLargeClass!}"
                id="cancelRecoveryAuthnCodesBtn" name="cancel-aia" value="true" />${msg("recovery-codes-action-cancel")}
            </button>
        <#else>
            <input type="submit"
            class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}"
            id="saveRecoveryAuthnCodesBtn" value="${msg("recovery-codes-action-complete")}"
            disabled
            />
        </#if>
    </form>

    <script>
        <#outputformat "JavaScript">
        /* copy recovery codes  */
        function copyRecoveryCodes() {
            var tmpTextarea = document.createElement("textarea");
            var codes = document.querySelectorAll("#kc-recovery-codes-list li");
            for (i = 0; i < codes.length; i++) {
                tmpTextarea.value = tmpTextarea.value + codes[i].innerText + "\n";
            }
            document.body.appendChild(tmpTextarea);
            tmpTextarea.select();
            document.execCommand("copy");
            document.body.removeChild(tmpTextarea);
        }

        var copyButton = document.getElementById("copyRecoveryCodes");
        copyButton && copyButton.addEventListener("click", function () {
            copyRecoveryCodes();
        });

        /* download recovery codes  */
        function formatCurrentDateTime() {
            var dt = new Date();
            var options = {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                timeZoneName: 'short'
            };

            return dt.toLocaleString('de-DE', options);
        }

        function parseRecoveryCodeList() {
            var recoveryCodes = document.querySelectorAll("#kc-recovery-codes-list li");
            var recoveryCodeList = "";

            for (var i = 0; i < recoveryCodes.length; i++) {
                var recoveryCodeLiElement = recoveryCodes[i].innerText;
                recoveryCodeList += recoveryCodeLiElement + "\r\n";
            }

            return recoveryCodeList;
        }

        /* Kennung auf dem Blatt: Wert steht nicht im FreeMarker-Modell (siehe Kopfkommentar),
           daher Schreibfeld statt Wert. */
        var KENNUNG_LINE = "Kennung: ________________________________";
        var KENNUNG_NOTE = "Diese Einmalcodes gelten nur zusammen mit Ihrer Kennung " +
            "(die Nummer, die Sie im Portal unter \u201eIhre Kennung\u201c gesehen haben)."; 

        function buildDownloadContent() {
            var recoveryCodeList = parseRecoveryCodeList();
            var dt = new Date();

            return fileBodyContent =
                ${msg("recovery-codes-download-file-header")?c} + "\n\n" +
                KENNUNG_LINE + "\n\n" +
                recoveryCodeList + "\n" +
                KENNUNG_NOTE + "\n\n" +
                ${msg("recovery-codes-download-file-description")?c} + "\n\n" +
                ${msg("recovery-codes-download-file-date")?c} + " " + formatCurrentDateTime();
        }

        function setUpDownloadLinkAndDownload(filename, text) {
            var el = document.createElement('a');
            el.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
            el.setAttribute('download', filename);
            el.style.display = 'none';
            document.body.appendChild(el);
            el.click();
            document.body.removeChild(el);
        }

        function downloadRecoveryCodes() {
            setUpDownloadLinkAndDownload('kc-download-recovery-codes.txt', buildDownloadContent());
        }

        var downloadButton = document.getElementById("downloadRecoveryCodes");
        downloadButton && downloadButton.addEventListener("click", downloadRecoveryCodes);

        /* print recovery codes */
        function buildPrintContent() {
            var recoveryCodeListHTML = document.getElementById('kc-recovery-codes-list').innerHTML;
            var styles =
                `@page { size: auto;  margin-top: 0; }
                body { width: 480px; }
                div { list-style-type: none; font-family: monospace }
                p:first-of-type { margin-top: 48px }`;

            return printFileContent =
                "<html><style>" + styles + "</style><body>" +
                "<title>kc-download-recovery-codes</title>" +
                "<p>" + ${msg("recovery-codes-download-file-header")?c} + "</p>" +
                "<p>" + KENNUNG_LINE + "</p>" +
                "<div>" + recoveryCodeListHTML + "</div>" +
                "<p>" + KENNUNG_NOTE + "</p>" +
                "<p>" + ${msg("recovery-codes-download-file-description")?c} + "</p>" +
                "<p>" + ${msg("recovery-codes-download-file-date")?c} + " " + formatCurrentDateTime() + "</p>" +
                "</body></html>";
        }

        function printRecoveryCodes() {
            var w = window.open();
            w.document.write(buildPrintContent());
            w.print();
            w.close();
        }

        var printButton = document.getElementById("printRecoveryCodes");
        printButton && printButton.addEventListener("click", printRecoveryCodes);
        </#outputformat>
    </script>
</#if>
</@layout.registrationLayout>

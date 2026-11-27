#!/usr/bin/python3
import os
import subprocess
import sys
import time

import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.connection import NoConnectException

NEVER_EXECUTE = 0
NO_UPDATE = 0
CONNECT_ATTEMPTS = 120
CONNECT_DELAY_SECONDS = 0.25

EXPORT_FILTERS = (
    ("com.sun.star.sheet.SpreadsheetDocument", "calc_pdf_Export"),
    ("com.sun.star.presentation.PresentationDocument", "impress_pdf_Export"),
    ("com.sun.star.drawing.DrawingDocument", "draw_pdf_Export"),
    ("com.sun.star.text.GenericTextDocument", "writer_pdf_Export"),
)


def props(**values):
    return tuple(PropertyValue(Name=name, Value=value) for name, value in values.items())


def connect(pipe_name, soffice):
    context = uno.getComponentContext()
    resolver = context.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", context)
    url = "uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe_name
    for _ in range(CONNECT_ATTEMPTS):
        if soffice.poll() is not None:
            raise RuntimeError("soffice exited before accepting connections")
        try:
            return resolver.resolve(url)
        except NoConnectException:
            time.sleep(CONNECT_DELAY_SECONDS)
    raise RuntimeError("soffice did not accept connections")


def fit_calc_to_page_width(document):
    styles = document.StyleFamilies.getByName("PageStyles")
    for name in styles.ElementNames:
        style = styles.getByName(name)
        width, height = style.Width, style.Height
        if width < height:
            style.Width, style.Height = height, width
        style.IsLandscape = True
        style.ScaleToPagesX = 1
        style.ScaleToPagesY = 0


def export_filter(document):
    for service, name in EXPORT_FILTERS:
        if document.supportsService(service):
            return name
    raise RuntimeError("unsupported document service")


def main():
    soffice_path, input_path, output_path, profile_dir, kind, page_limit = sys.argv[1:7]
    pipe_name = "chalk%d" % os.getpid()
    soffice = subprocess.Popen(
        [
            soffice_path,
            "-env:UserInstallation=" + uno.systemPathToFileUrl(profile_dir),
            "--headless",
            "--norestore",
            "--nolockcheck",
            "--nologo",
            "--nodefault",
            "--accept=pipe,name=%s;urp;" % pipe_name,
        ],
        stdin=subprocess.DEVNULL,
    )
    try:
        remote = connect(pipe_name, soffice)
        desktop = remote.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", remote)
        document = desktop.loadComponentFromURL(
            uno.systemPathToFileUrl(input_path),
            "_blank",
            0,
            props(Hidden=True, ReadOnly=True, MacroExecutionMode=NEVER_EXECUTE, UpdateDocMode=NO_UPDATE),
        )
        if document is None:
            raise RuntimeError("document could not be loaded")
        if kind == "spreadsheet":
            fit_calc_to_page_width(document)
        filter_data = uno.Any("[]com.sun.star.beans.PropertyValue", props(PageRange="1-" + page_limit))
        document.storeToURL(
            uno.systemPathToFileUrl(output_path),
            props(FilterName=export_filter(document), FilterData=filter_data),
        )
        document.close(True)
        try:
            desktop.terminate()
        except Exception:
            pass
        soffice.wait(timeout=10)
    finally:
        if soffice.poll() is None:
            soffice.kill()
            soffice.wait()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("%s: %s" % (type(error).__name__, error), file=sys.stderr)
        sys.exit(1)

package main

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type dtoField struct {
	Name string
	JSON string
	Type string
}

type handlerClue struct {
	Name         string
	RequestTypes []string
	Success      []string
	Errors       []string
	ServiceError []string
}

func main() {
	root := "internal/httpapi"
	files, err := filepath.Glob(filepath.Join(root, "*.go"))
	if err != nil {
		panic(err)
	}

	var structs []string
	var handlers []handlerClue
	for _, file := range files {
		parsed, err := parser.ParseFile(token.NewFileSet(), file, nil, 0)
		if err != nil {
			panic(err)
		}

		structs = append(structs, findDTOs(parsed)...)
		handlers = append(handlers, findHandlers(parsed)...)
	}

	sort.Strings(structs)
	sort.Slice(handlers, func(i, j int) bool { return handlers[i].Name < handlers[j].Name })

	fmt.Println("DTO structs from json tags:")
	for _, item := range structs {
		fmt.Println(item)
	}

	fmt.Println()
	fmt.Println("Handler body clues:")
	for _, handler := range handlers {
		if len(handler.RequestTypes) == 0 && len(handler.Success) == 0 && len(handler.Errors) == 0 && len(handler.ServiceError) == 0 {
			continue
		}
		fmt.Printf("%s request=%v success=%v directErrors=%v delegatedErrors=%v\n",
			handler.Name,
			unique(handler.RequestTypes),
			unique(handler.Success),
			unique(handler.Errors),
			unique(handler.ServiceError),
		)
	}
}

func findDTOs(file *ast.File) []string {
	var out []string
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.TYPE {
			continue
		}
		for _, spec := range gen.Specs {
			typeSpec := spec.(*ast.TypeSpec)
			structType, ok := typeSpec.Type.(*ast.StructType)
			if !ok {
				continue
			}

			fields := jsonFields(structType)
			if len(fields) == 0 {
				continue
			}

			var parts []string
			for _, field := range fields {
				parts = append(parts, fmt.Sprintf("%s:%s=%s", field.JSON, field.Type, field.Name))
			}
			out = append(out, fmt.Sprintf("%s {%s}", typeSpec.Name.Name, strings.Join(parts, ", ")))
		}
	}
	return out
}

func jsonFields(structType *ast.StructType) []dtoField {
	var fields []dtoField
	for _, field := range structType.Fields.List {
		if field.Tag == nil || len(field.Names) == 0 {
			continue
		}
		tag, err := strconv.Unquote(field.Tag.Value)
		if err != nil {
			continue
		}
		jsonName := jsonTagName(tag)
		if jsonName == "" || jsonName == "-" {
			continue
		}
		fields = append(fields, dtoField{
			Name: field.Names[0].Name,
			JSON: jsonName,
			Type: exprString(field.Type),
		})
	}
	return fields
}

func jsonTagName(tag string) string {
	for _, part := range strings.Split(tag, " ") {
		if strings.HasPrefix(part, "json:") {
			value, err := strconv.Unquote(strings.TrimPrefix(part, "json:"))
			if err != nil {
				return ""
			}
			return strings.Split(value, ",")[0]
		}
	}
	return ""
}

func findHandlers(file *ast.File) []handlerClue {
	var handlers []handlerClue
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || !strings.HasPrefix(fn.Name.Name, "handle") || fn.Body == nil {
			continue
		}

		varTypes := map[string]string{}
		clue := handlerClue{Name: fn.Name.Name}
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			switch n := node.(type) {
			case *ast.DeclStmt:
				gen, ok := n.Decl.(*ast.GenDecl)
				if !ok {
					return true
				}
				for _, spec := range gen.Specs {
					value, ok := spec.(*ast.ValueSpec)
					if !ok || value.Type == nil {
						continue
					}
					for _, name := range value.Names {
						varTypes[name.Name] = exprString(value.Type)
					}
				}
			case *ast.CallExpr:
				name := callName(n.Fun)
				switch name {
				case "decodeRequest":
					if len(n.Args) >= 2 {
						if unary, ok := n.Args[1].(*ast.UnaryExpr); ok {
							if ident, ok := unary.X.(*ast.Ident); ok {
								clue.RequestTypes = append(clue.RequestTypes, varTypes[ident.Name])
							}
						}
					}
				case "writeJSON":
					if len(n.Args) >= 3 {
						clue.Success = append(clue.Success, fmt.Sprintf("%s => %s", exprString(n.Args[1]), exprString(n.Args[2])))
					}
				case "writeError":
					if len(n.Args) >= 3 {
						clue.Errors = append(clue.Errors, fmt.Sprintf("%s/%s", exprString(n.Args[1]), exprString(n.Args[2])))
					}
				default:
					if strings.HasPrefix(name, "write") && strings.HasSuffix(name, "ServiceError") {
						clue.ServiceError = append(clue.ServiceError, name)
					}
				}
			}
			return true
		})
		handlers = append(handlers, clue)
	}
	return handlers
}

func callName(expr ast.Expr) string {
	switch n := expr.(type) {
	case *ast.Ident:
		return n.Name
	case *ast.SelectorExpr:
		return exprString(n)
	}
	return ""
}

func exprString(expr ast.Expr) string {
	var builder bytes.Buffer
	if err := printer.Fprint(&builder, token.NewFileSet(), expr); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "format expr: %v\n", err)
		return "<expr>"
	}
	return strings.ReplaceAll(builder.String(), "\n", "")
}

func unique(values []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}
